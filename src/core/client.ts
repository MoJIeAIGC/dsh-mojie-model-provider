import {
  BlockAssembler,
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmDiscoveredModel,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolCallBlock,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { builtinModel, mergeResolvedModelInfo, type MojieCatalogModel } from '../catalog.js'
import { fetchModelListing } from '../discovery.js'
import { serializeRequest } from '../serialize.js'
import { modelsURL, normalizeBaseURL, responsesURL } from './endpoint.js'
import { streamResponses } from './stream.js'

/** Message content: plain text or DSH content blocks (text, image, reasoning, …). */
export type MojieContent = string | readonly ContentBlock[]

/**
 * One conversation turn for {@link MojieClient}.
 *
 * A string `content` is the common case; pass DSH content blocks when a turn
 * carries images or reasoning. `role: 'tool'` must name the call it answers.
 */
export type MojieChatMessage =
  | { readonly role: 'user' | 'assistant' | 'system' | 'developer'; readonly content: MojieContent }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: MojieContent }

/** One Mojie Responses call. */
export interface MojieChatRequest {
  /** Exact provider model id, e.g. `claude-opus-5.5`. */
  readonly model: string
  /** Conversation turns in order. */
  readonly messages: readonly MojieChatMessage[]
  /** System instructions, mapped to the Responses `instructions` field. */
  readonly system?: string
  /** Tool declarations the model may call. */
  readonly tools?: readonly ToolSchema[]
  /** Sampling temperature, forwarded when set. */
  readonly temperature?: number
  /** Output cap, forwarded as `max_output_tokens`. */
  readonly maxTokens?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** Assembled result of one non-streaming call. */
export interface MojieChatResult {
  /** Model id the caller requested. */
  readonly model: string
  /** Concatenated visible text. */
  readonly text: string
  /** Concatenated reasoning/thinking text, when the model emits one. */
  readonly reasoning: string
  /** Tool calls the model asked for, in stream order. */
  readonly toolCalls: readonly ToolCallBlock[]
  /** Every assembled block, in stream order. */
  readonly blocks: readonly ContentBlock[]
  /** Token accounting reported by the provider. */
  readonly usage?: TokenUsage
  /** Why generation stopped. */
  readonly finish: FinishReason
}

/** Construction options for {@link MojieClient}. */
export interface MojieClientOptions {
  /** Mojie site root, or the same root with a trailing `/v1`. */
  readonly baseURL: string
  /** Raw API key. Never logged; passed only as a bearer header. */
  readonly apiKey: string
  /** Header deadline in milliseconds; defaults to 60s. */
  readonly firstByteTimeoutMs?: number
  /** Maximum silence between received bytes; defaults to 90s. */
  readonly streamIdleTimeoutMs?: number
  /** Whole-exchange backstop in milliseconds; `0` (default) disables it. */
  readonly requestTimeoutMs?: number
  /** Fetch implementation, injectable for tests and custom transports. */
  readonly fetch?: typeof fetch
  /** Provider route id reported by {@link MojieClient.resolveModel}; defaults to `mojie`. */
  readonly provider?: string
}

/**
 * Framework-free Mojie client: model discovery, streaming, and one-shot calls.
 *
 * It depends only on `@deepseek-ai/dsh-llm` types plus `fetch`, so a plugin can
 * use it with its own key and endpoint (tests, scripts, per-user credentials)
 * without mounting the provider plugin. When you want the *configured* route,
 * inject the `mojie` service instead and let it hand you a bound client.
 */
export class MojieClient {
  private readonly baseURL: string
  private readonly options: MojieClientOptions

  /**
   * @param options - endpoint, credential, and timing overrides.
   * @throws {LlmError} `INVALID_CONFIG` for an unusable endpoint, `MISSING_CREDENTIAL` for an empty key.
   */
  constructor(options: MojieClientOptions) {
    this.options = options
    this.baseURL = normalizeBaseURL(options.baseURL)
    if (options.apiKey.trim().length === 0) {
      throw new LlmError('mojie client requires a non-empty API key', 'MISSING_CREDENTIAL')
    }
  }

  /** Provider route id this client reports model metadata under. */
  get provider(): string {
    return this.options.provider ?? 'mojie'
  }

  /** Canonical site root. */
  get siteURL(): string {
    return this.baseURL
  }

  /** `POST` target for model calls. */
  get responsesEndpoint(): string {
    return responsesURL(this.baseURL)
  }

  /** `GET` target for model discovery. */
  get modelsEndpoint(): string {
    return modelsURL(this.baseURL)
  }

  /**
   * Read the live `/v1/models` listing (no caching).
   * @param signal - optional cancellation.
   * @returns advisory model rows in endpoint order.
   */
  async listModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    return fetchModelListing(this.baseURL, this.options.apiKey, signal)
  }

  /**
   * Built-in catalog knowledge for one model id.
   * @param id - exact provider model id.
   * @returns shipped metadata, or undefined for an unknown id.
   */
  builtinModel(id: string): MojieCatalogModel | undefined {
    return builtinModel(id)
  }

  /**
   * Shipped metadata resolved with provider defaults, without any network call.
   * @param id - exact provider model id.
   * @returns resolved model metadata (context window, output cap, modalities).
   */
  resolveModel(id: string): LlmResolvedModelInfo {
    return mergeResolvedModelInfo(this.provider, id)
  }

  /**
   * Stream one model call as DSH stream chunks.
   *
   * Image blocks are sent as their placeholder text: turning a durable image
   * into request bytes needs the host attachment service, which only the
   * provider route has. Use `ctx.llm.stream({ provider: 'mojie', … })` when a
   * turn carries images.
   * @param request - model, conversation turns, and optional tools/limits.
   * @returns translated chunks (`block-*`, `text-delta`, `usage`, `finish`).
   */
  async *stream(request: MojieChatRequest): AsyncIterable<StreamChunk> {
    const options = this.options
    yield* streamResponses({
      endpoint: responsesURL(this.baseURL),
      apiKey: options.apiKey,
      ...options.firstByteTimeoutMs === undefined ? {} : { firstByteTimeoutMs: options.firstByteTimeoutMs },
      ...options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
      ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.fetch === undefined ? {} : { fetchImpl: options.fetch },
      ...request.signal === undefined ? {} : { signal: request.signal },
      prepareBody: () => Promise.resolve(serializeRequest(this.toGenerateOptions(request))),
    })
  }

  /**
   * Run one call to completion and assemble its result.
   * @param request - model, conversation turns, and optional tools/limits.
   * @returns assembled text, reasoning, tool calls, usage, and finish reason.
   */
  async chat(request: MojieChatRequest): Promise<MojieChatResult> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.stream(request)) assembler.push(chunk)
    const blocks = assembler.blocks()
    const usage = assembler.usage
    return {
      model: request.model,
      text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      reasoning: blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join(''),
      toolCalls: blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call'),
      blocks,
      finish: assembler.finish,
      ...usage === undefined ? {} : { usage },
    }
  }

  /**
   * Convenience text completion.
   * @param input - a full request, or a prompt string paired with an options object.
   * @param options - model and generation options when `input` is a string.
   * @returns the visible text of the reply.
   */
  async chatText(request: MojieChatRequest): Promise<string>
  async chatText(prompt: string, options: Omit<MojieChatRequest, 'messages'>): Promise<string>
  async chatText(input: string | MojieChatRequest, options?: Omit<MojieChatRequest, 'messages'>): Promise<string> {
    if (typeof input !== 'string') return (await this.chat(input)).text
    if (options?.model === undefined) {
      throw new LlmError('mojie chatText(prompt, options) requires options.model', 'INVALID_CONFIG')
    }
    return (await this.chat({ ...options, messages: [{ role: 'user', content: input }] })).text
  }

  private toGenerateOptions(request: MojieChatRequest): GenerateOptions {
    return {
      provider: this.provider,
      model: request.model,
      messages: request.messages.map(toRequestMessage),
      ...request.system === undefined ? {} : { system: request.system },
      ...request.tools === undefined ? {} : { tools: [...request.tools] },
      ...request.temperature === undefined ? {} : { temperature: request.temperature },
      ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    }
  }
}

/**
 * Project one client message onto the request vocabulary `serializeRequest` reads.
 *
 * Only `role`, `content`, and `toolCallId` matter for the wire format; the
 * durable message identity and source fields belong to the session log, not to
 * an ad-hoc call, so they are absent here.
 */
function toRequestMessage(message: MojieChatMessage): RequestMessage {
  const content: ContentBlock[] = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : [...message.content]
  if (message.role === 'tool') {
    return { role: 'tool', content, toolCallId: message.toolCallId } as unknown as RequestMessage
  }
  return { role: message.role, content } as unknown as RequestMessage
}
