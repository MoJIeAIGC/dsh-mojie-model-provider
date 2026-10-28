import { requestImageHandleText, textOnlyImageText, type ImageAttachmentAccess, type RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

type ResponsesInputItem =
  | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }> }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { role: 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/**
 * Serialized Mojie Responses request body.
 */
export interface MojieResponsesRequest {
  model: string
  instructions?: string
  input: string | ResponsesInputItem[]
  tools?: Array<{ type: 'function'; name: string; description: string; parameters: Record<string, unknown> }>
  stream: true
  temperature?: number
  max_output_tokens?: number
  top_p?: number
}

/**
 * Request-local image material already projected by the attachment service.
 */
export interface MojieRequestImages {
  readonly requestImages: ReadonlyMap<string, RequestImageAttachment>
  readonly resolveImageAccess?: (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

type UserContentPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }

function flattenText(
  blocks: readonly ContentBlock[],
  requestImages?: MojieRequestImages,
): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return block.text
      case 'image': {
        const version = requestImages?.requestImages.get(block.attachment.attachmentId)
        const access = requestImages?.resolveImageAccess?.(block.attachment)
        return version === undefined
          ? textOnlyImageText(block.attachment)
          : requestImageHandleText(
            block.attachment,
            version,
            access,
          )
      }
      case 'file':
        return filePlaceholder(block.attachment)
      case 'tool-call':
        return ''
      default:
        return ''
    }
  }).filter((part) => part.length > 0).join('\n')
}

function filePlaceholder(ref: FileAttachmentRef): string {
  return `[file ${JSON.stringify(ref.name)} (${ref.bytes} bytes)]`
}

function dataUrlOf(image: RequestImageAttachment): string {
  validateImageMediaType(image.mediaType)
  const encoded = Buffer.from(image.data).toString('base64')
  return `data:${image.mediaType};base64,${encoded}`
}

function validateImageMediaType(mediaType: ImageMediaType): void {
  switch (mediaType) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return
  }
}

function splitInstructions(options: GenerateOptions): { instructions?: string; messages: readonly RequestMessage[] } {
  const instructions: string[] = []
  if (options.system !== undefined && options.system.length > 0) instructions.push(options.system)
  let index = 0
  while (index < options.messages.length) {
    const message = options.messages[index]
    if (message?.role !== 'system') break
    const text = flattenText(message.content)
    if (text.length > 0) instructions.push(text)
    index += 1
  }
  return {
    ...instructions.length === 0 ? {} : { instructions: instructions.join('\n\n') },
    messages: options.messages.slice(index),
  }
}

function serializeUserMessage(
  content: readonly ContentBlock[],
  requestImages?: MojieRequestImages,
): ResponsesInputItem | undefined {
  const parts: UserContentPart[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        if (block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
        break
      case 'image': {
        const version = requestImages?.requestImages.get(block.attachment.attachmentId)
        const access = requestImages?.resolveImageAccess?.(block.attachment)
        if (version === undefined) {
          parts.push({ type: 'input_text', text: textOnlyImageText(block.attachment) })
          break
        }
        parts.push({
          type: 'input_text',
          text: requestImageHandleText(block.attachment, version, access),
        })
        parts.push({ type: 'input_image', image_url: dataUrlOf(version) })
        break
      }
      case 'file':
        parts.push({ type: 'input_text', text: filePlaceholder(block.attachment) })
        break
      default:
        break
    }
  }
  return parts.length === 0 ? undefined : { role: 'user', content: parts }
}

/**
 * Text used when the provider contract requires a final user turn and the DSH
 * history has none (a trailing assistant message, a trailing tool call with no
 * result, or an otherwise empty conversation). Anthropic-backed models reject
 * assistant prefill; a short continuation prompt keeps the request valid and
 * asks the model to pick up where the history left off.
 */
const CONTINUE_TEXT = 'Continue.'

/**
 * Anthropic-backed providers accept only a JSON object as historical tool
 * arguments. A model that emitted empty or malformed arguments must not make
 * the whole history unsendable; replay `{}` instead, as the first-party
 * adapters do.
 */
function replayableToolArguments(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? raw : '{}'
  } catch {
    return '{}'
  }
}

function serializeAssistantBlocks(
  content: readonly ContentBlock[],
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        if (block.text.length > 0) items.push({ role: 'assistant', content: [{ type: 'output_text', text: block.text }] })
        break
      case 'tool-call':
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: replayableToolArguments(block.arguments),
        })
        break
      default:
        break
    }
  }
  return items
}

/** Whether the final input item is an assistant-side turn that providers reject as prefill. */
function endsWithAssistant(input: readonly ResponsesInputItem[]): boolean {
  const last = input[input.length - 1]
  if (last === undefined) return false
  if ('type' in last) return last.type === 'function_call'
  return last.role === 'assistant'
}

/**
 * Serialize one DSH request into Mojie's Responses request body.
 * @param options - assembled model request.
 * @param requestImages - deterministic request images for image-capable models.
 * @returns Mojie Responses body.
 */
export function serializeRequest(
  options: GenerateOptions,
  requestImages?: MojieRequestImages,
): MojieResponsesRequest {
  const { instructions, messages } = splitInstructions(options)
  const input: ResponsesInputItem[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const item = serializeUserMessage(message.content, requestImages)
        if (item !== undefined) input.push(item)
        break
      }
      case 'assistant':
        input.push(...serializeAssistantBlocks(message.content))
        break
      case 'tool': {
        const output = flattenText(message.content, requestImages)
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output })
        break
      }
      case 'developer':
      case 'system': {
        const text = flattenText(message.content, requestImages)
        if (text.length > 0) input.push({ role: 'developer', content: text })
        break
      }
    }
  }
  // Anthropic-backed models reject assistant prefill: a request whose final
  // item is assistant (or a tool call with no result) must be completed with a
  // user turn. A fully empty conversation gets the same guard instead of the
  // bare empty-string input the Responses API accepts syntactically but these
  // models do not accept semantically.
  if (input.length === 0 || endsWithAssistant(input)) {
    input.push({ role: 'user', content: [{ type: 'input_text', text: CONTINUE_TEXT }] })
  }
  return {
    model: options.model,
    ...instructions === undefined ? {} : { instructions },
    input,
    ...options.tools === undefined || options.tools.length === 0
      ? {}
      : {
        tools: options.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    stream: true,
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
  }
}
