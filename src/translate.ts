import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SseEvent } from './sse.js'
import { isContextOverflowDetail } from './transport.js'

interface ResponseUsageWire {
  input_tokens?: unknown
  output_tokens?: unknown
  total_tokens?: unknown
}

interface WireResponse {
  usage?: ResponseUsageWire
  output?: unknown
  incomplete_details?: unknown
}

interface BlockState {
  readonly key: string
  readonly index: number
  readonly kind: 'text' | 'tool-call'
  text: string
  id?: ReturnType<typeof ToolCallId>
  name?: string
  argumentsText: string
  started: boolean
  finished: boolean
  announced: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmError('Mojie Responses expected a JSON object event', 'MALFORMED_RESPONSE')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, detail: string): string {
  if (typeof value !== 'string') throw new LlmError(`Mojie Responses ${detail} must be a string`, 'MALFORMED_RESPONSE')
  return value
}

function numberField(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LlmError(`Mojie Responses ${detail} must be a non-negative integer`, 'MALFORMED_RESPONSE')
  }
  return value as number
}

/**
 * Map Mojie usage counters to DSH token usage.
 * @param raw - provider usage object.
 * @returns mapped usage.
 */
export function mapUsage(raw: unknown): TokenUsage {
  const usage = object(raw)
  const mapped: TokenUsage = {
    inputTokens: numberField(usage.input_tokens ?? 0, 'usage.input_tokens'),
    outputTokens: numberField(usage.output_tokens ?? 0, 'usage.output_tokens'),
  }
  if (usage.total_tokens !== undefined) mapped.totalTokens = numberField(usage.total_tokens, 'usage.total_tokens')
  return mapped
}

function ensureBlock(
  blocks: Map<string, BlockState>,
  key: string,
  kind: BlockState['kind'],
  nextIndex: () => number,
): BlockState {
  const existing = blocks.get(key)
  if (existing !== undefined) return existing
  const created: BlockState = {
    key,
    index: nextIndex(),
    kind,
    text: '',
    argumentsText: '',
    started: false,
    finished: false,
    announced: false,
  }
  blocks.set(key, created)
  return created
}

function hasToolCalls(output: unknown): boolean {
  return Array.isArray(output) && output.some((item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'function_call')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Map a provider-reported failure onto DSH's provider-neutral error taxonomy.
 * Content refusals are not retryable, so they get their own code instead of
 * `SERVER`.
 * @param code - provider error code or type.
 * @param message - provider error message.
 * @returns stable harness error code.
 */
export function classifyFailure(code: string, message: string): string {
  const detail = `${code} ${message}`
  if (isContextOverflowDetail(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (/rate.?limit|too many requests|\b429\b/iu.test(detail)) return 'RATE_LIMIT'
  if (/unauthor|forbidden|permission|access denied|invalid api key|\b40[13]\b/iu.test(detail)) return 'AUTH'
  if (/refus|content filter|safety|blocked|moderation/iu.test(detail)) return 'PROVIDER_REFUSED'
  return 'SERVER'
}

/**
 * Build the typed error for a `response.failed` / `response.error` frame.
 *
 * The relay reports upstream failures inside the stream instead of as an HTTP
 * status, so the envelope is the only place the real reason exists.
 * @param event - decoded SSE event.
 * @returns typed harness error carrying the provider reason.
 */
export function providerFailure(event: Record<string, unknown>): LlmError {
  const envelope = isObject(event.response) ? event.response : event
  const error = isObject(envelope.error) ? envelope.error : isObject(event.error) ? event.error : envelope
  const code = firstString(error.code, error.type, envelope.code) ?? 'PROVIDER_ERROR'
  const message = firstString(error.message, envelope.message, event.message) ?? 'Mojie Responses reported a failure'
  return new LlmError(`Mojie Responses failed (${code}): ${message}`, classifyFailure(code, message))
}

/**
 * Whether translated blocks carry anything a reader would see.
 * @param blocks - translated block states.
 * @returns true for non-empty text or any tool call.
 */
function hasVisibleContent(blocks: ReadonlyMap<string, BlockState>): boolean {
  for (const block of blocks.values()) {
    if (block.kind === 'tool-call') return true
    if (block.text.trim().length > 0) return true
  }
  return false
}

function hasToolCallBlocks(blocks: ReadonlyMap<string, BlockState>): boolean {
  for (const block of blocks.values()) {
    if (block.kind === 'tool-call') return true
  }
  return false
}

function incompleteReason(response: WireResponse): string | undefined {
  const details = isObject(response.incomplete_details) ? response.incomplete_details : undefined
  return firstString(details?.reason)
}

/**
 * Translate Mojie Responses SSE events into DSH stream chunks.
 * @param events - parsed SSE events in arrival order.
 * @returns translated chunks.
 */
export async function* translate(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, BlockState>()
  let nextBlockIndex = 0
  let finalReason: FinishReason | undefined
  let finalUsage: TokenUsage | undefined

  for await (const frame of events) {
    if (frame.data === '[DONE]') break
    const event = object(JSON.parse(frame.data))
    switch (event.type) {
      case 'response.output_item.added': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const item = object(event.item)
        if (item.type === 'function_call') {
          const state = ensureBlock(blocks, `fc:${outputIndex}`, 'tool-call', () => nextBlockIndex++)
          if (!state.started) {
            state.started = true
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          }
          state.id = ToolCallId(string(item.call_id, 'item.call_id'))
          state.name = string(item.name, 'item.name')
          if (!state.announced) {
            state.announced = true
            yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: '' }
          }
        }
        break
      }
      case 'response.content_part.added': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const contentIndex = numberField(event.content_index, 'content_index')
        const part = object(event.part)
        if (part.type === 'output_text') {
          const state = ensureBlock(blocks, `text:${outputIndex}:${contentIndex}`, 'text', () => nextBlockIndex++)
          if (!state.started) {
            state.started = true
            yield { type: 'block-start', index: state.index, blockType: 'text' }
          }
          const initial = typeof part.text === 'string' ? part.text : ''
          if (initial.length > 0) {
            state.text += initial
            yield { type: 'text-delta', index: state.index, text: initial }
          }
        }
        break
      }
      case 'response.output_text.delta': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const contentIndex = numberField(event.content_index, 'content_index')
        const state = ensureBlock(blocks, `text:${outputIndex}:${contentIndex}`, 'text', () => nextBlockIndex++)
        if (!state.started) {
          state.started = true
          yield { type: 'block-start', index: state.index, blockType: 'text' }
        }
        const delta = string(event.delta, 'delta')
        state.text += delta
        yield { type: 'text-delta', index: state.index, text: delta }
        break
      }
      case 'response.output_text.done': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const contentIndex = numberField(event.content_index, 'content_index')
        const state = ensureBlock(blocks, `text:${outputIndex}:${contentIndex}`, 'text', () => nextBlockIndex++)
        if (state.text.length === 0 && typeof event.text === 'string' && event.text.length > 0) {
          state.text = event.text
        }
        break
      }
      case 'response.content_part.done': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const contentIndex = numberField(event.content_index, 'content_index')
        const part = object(event.part)
        if (part.type === 'output_text') {
          const state = ensureBlock(blocks, `text:${outputIndex}:${contentIndex}`, 'text', () => nextBlockIndex++)
          if (!state.started) {
            state.started = true
            yield { type: 'block-start', index: state.index, blockType: 'text' }
          }
          if (state.text.length === 0 && typeof part.text === 'string' && part.text.length > 0) {
            state.text = part.text
            yield { type: 'text-delta', index: state.index, text: part.text }
          }
          if (!state.finished) {
            state.finished = true
            yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
          }
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const state = ensureBlock(blocks, `fc:${outputIndex}`, 'tool-call', () => nextBlockIndex++)
        if (!state.started) {
          state.started = true
          yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
        }
        const delta = string(event.delta, 'delta')
        state.argumentsText += delta
        if (state.id !== undefined) {
          yield {
            type: 'tool-call-delta',
            index: state.index,
            id: state.id,
            ...state.name === undefined ? {} : { name: state.name },
            argumentsDelta: delta,
          }
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const state = ensureBlock(blocks, `fc:${outputIndex}`, 'tool-call', () => nextBlockIndex++)
        if (state.argumentsText.length === 0 && typeof event.arguments === 'string') {
          state.argumentsText = event.arguments
        }
        break
      }
      case 'response.output_item.done': {
        const outputIndex = numberField(event.output_index, 'output_index')
        const item = object(event.item)
        if (item.type === 'function_call') {
          const state = ensureBlock(blocks, `fc:${outputIndex}`, 'tool-call', () => nextBlockIndex++)
          if (!state.started) {
            state.started = true
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          }
          state.id = ToolCallId(string(item.call_id, 'item.call_id'))
          state.name = string(item.name, 'item.name')
          const fullArguments = string(item.arguments, 'item.arguments')
          if (!state.announced) {
            state.announced = true
            yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: '' }
          }
          if (state.argumentsText.length === 0 && fullArguments.length > 0) {
            state.argumentsText = fullArguments
            yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: fullArguments }
          }
          if (!state.finished) {
            state.finished = true
            yield {
              type: 'block-end',
              index: state.index,
              block: {
                type: 'tool-call',
                id: state.id,
                name: state.name,
                arguments: state.argumentsText,
              },
            }
          }
        }
        break
      }
      case 'response.completed': {
        const response = object(event.response) as WireResponse
        finalUsage = mapUsage(response.usage ?? {})
        finalReason = hasToolCalls(response.output) || hasToolCallBlocks(blocks)
          ? { kind: 'tool-calls' }
          : { kind: 'stop' }
        break
      }
      case 'response.incomplete': {
        // Truncated generation: keep the text already streamed and report the
        // provider's own reason instead of failing the whole attempt.
        const response = object(event.response) as WireResponse
        finalUsage = mapUsage(response.usage ?? {})
        finalReason = incompleteReason(response) === 'max_output_tokens'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' }
        break
      }
      case 'response.failed':
      case 'response.error':
        // The relay reports upstream failures inside the stream; without this
        // branch the real reason is lost behind a generic STREAM_CLOSED.
        throw providerFailure(event)
      case 'response.created':
      case 'response.in_progress':
        break
      default:
        break
    }
  }

  if (finalReason === undefined || finalUsage === undefined) {
    throw new LlmError('Mojie Responses stream ended before response.completed', 'STREAM_CLOSED')
  }
  if (finalReason.kind === 'stop' && !hasVisibleContent(blocks)) {
    // A "completed" response carrying only hidden reasoning (e.g. 17 output
    // tokens and an empty text block) must be retryable, not a silent success.
    throw new LlmError('Mojie Responses completed with no visible text or tool calls', EMPTY_RESPONSE_CODE)
  }

  yield { type: 'usage', usage: finalUsage }
  yield { type: 'finish', reason: finalReason }
}
