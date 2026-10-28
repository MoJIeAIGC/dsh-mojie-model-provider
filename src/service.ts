import { Service, type Context } from '@deepseek-ai/cordis'
import {
  LlmError,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mergeCatalog, mergeResolvedModelInfo } from './catalog.js'
import { fetchModelListing } from './discovery.js'
import { normalizeBaseURL } from './core/endpoint.js'
import { MojieClient, type MojieChatRequest, type MojieChatResult } from './core/client.js'
import type { ResolvedConfig } from './config.js'

/** Service name other plugins inject. */
export const MOJIE_SERVICE = 'mojie'

/** Host wiring the service needs from the provider plugin. */
export interface MojieServiceOptions {
  /** Read the live plugin configuration for one call. */
  readonly config: () => ResolvedConfig
  /** Resolve one credential reference through the host seam. */
  readonly resolveApiKey: (ref: string) => Promise<string>
  /** Provider route id reported by model metadata; defaults to `mojie`. */
  readonly provider?: string
}

/** Options for the one-shot text helper; `model` falls back to the first configured model. */
export type MojieChatTextOptions = Omit<MojieChatRequest, 'messages' | 'model'> & {
  /** Exact provider model id. */
  readonly model?: string
}

/**
 * The `mojie` service: everything another plugin needs to call Mojie through
 * the *running* provider configuration (baseURL, credential reference, timeouts)
 * without rebuilding any of it.
 *
 * Registered by the provider plugin and unregistered with it, so consumers
 * declare `inject: ['mojie']` and get the service only while a route exists.
 *
 * @example
 * ```ts
 * import { type Context } from '@deepseek-ai/cordis'
 *
 * export const name = 'my-summarizer'
 * export const inject = ['mojie']
 *
 * export function apply(ctx: Context): void {
 *   ctx.on('my/command', async (text: string) => {
 *     const summary = await ctx.mojie.chatText(`用一句话总结：\n${text}`, { model: 'gpt-6-sol' })
 *     ctx.logger.info(summary)
 *   })
 * }
 * ```
 */
export class MojieService extends Service {
  constructor(context: Context, private readonly dependencies: MojieServiceOptions) {
    super(context, MOJIE_SERVICE)
  }

  /** Provider route id reported by this service. */
  get provider(): string {
    return this.dependencies.provider ?? MOJIE_SERVICE
  }

  /** Current configured site root, normalized to its origin. */
  get baseURL(): string {
    return normalizeBaseURL(this.config().baseURL)
  }

  /**
   * One configuration snapshot for the current call.
   *
   * Read this instead of calling several service methods when a single operation
   * must not observe a settings edit halfway through.
   * @returns the live plugin configuration.
   */
  config(): ResolvedConfig {
    return this.dependencies.config()
  }

  /**
   * Build a {@link MojieClient} bound to the current configuration and
   * credential. The key is resolved on every call, so a key replaced through the
   * Models page applies immediately.
   * @returns a client for this configuration snapshot.
   */
  async client(): Promise<MojieClient> {
    const config = this.config()
    const apiKey = await this.dependencies.resolveApiKey(config.apiKeyEnv)
    return new MojieClient({
      baseURL: config.baseURL,
      apiKey,
      firstByteTimeoutMs: config.firstByteTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      provider: this.provider,
    })
  }

  /**
   * Merged advisory catalog: explicit configuration first, then live discovery.
   * @param signal - optional cancellation.
   * @returns model entries for selectors and diagnostics.
   */
  async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const config = this.config()
    const apiKey = await this.dependencies.resolveApiKey(config.apiKeyEnv)
    const discovered = await fetchModelListing(config.baseURL, apiKey, signal)
    return mergeCatalog(this.provider, config.models, discovered)
  }

  /**
   * Exact-route metadata for one model: configured overrides, then the shipped
   * catalog. No network call, so it also answers offline.
   * @param id - exact provider model id.
   * @returns resolved metadata (context window, output cap, modalities, reasoning).
   */
  resolveModel(id: string): LlmResolvedModelInfo {
    const config = this.config()
    const configured = config.models.find((entry) => entry.id === id)
    return mergeResolvedModelInfo(this.provider, id, configured)
  }

  /**
   * Stream one model call with the plugin's configuration and credential.
   *
   * Image blocks are sent as placeholder text here, because request-image
   * derivation needs the host attachment service. For image turns call the
   * provider route instead: `ctx.llm.stream({ provider: 'mojie', … })`.
   * @param request - model, conversation turns, and optional tools/limits.
   * @returns translated stream chunks.
   */
  async *stream(request: MojieChatRequest): AsyncIterable<StreamChunk> {
    const client = await this.client()
    yield* client.stream(request)
  }

  /**
   * Run one model call to completion.
   * @param request - model, conversation turns, and optional tools/limits.
   * @returns assembled text, reasoning, tool calls, usage, and finish reason.
   */
  async chat(request: MojieChatRequest): Promise<MojieChatResult> {
    return (await this.client()).chat(request)
  }

  /**
   * One-shot text completion on top of the configured route.
   * @param prompt - user prompt.
   * @param options - model (defaults to the first explicitly configured model) and generation options.
   * @returns the visible text of the reply.
   */
  async chatText(prompt: string, options: MojieChatTextOptions = {}): Promise<string> {
    const model = options.model ?? this.config().models[0]?.id
    if (model === undefined) {
      throw new LlmError(
        'mojie: chatText needs an explicit model because no models are configured on the provider route',
        'INVALID_CONFIG',
      )
    }
    return (await this.chat({ ...options, model, messages: [{ role: 'user', content: prompt }] })).text
  }
}
