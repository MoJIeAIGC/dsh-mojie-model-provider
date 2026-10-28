import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requiredImageOffload,
  type GenerateOptions,
  type ImageAttachmentAccessResolver,
  type LlmDiscoveredModel,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { fetchModelListing } from './discovery.js'
import { mergeCatalog, mergeResolvedModelInfo } from './catalog.js'
import { responsesURL, type ResolvedConfig } from './config.js'
import { serializeRequest } from './serialize.js'
import { streamResponses } from './core/stream.js'

/** How long one `/v1/models` listing answers advisory model metadata. */
const CATALOG_TTL_MS = 10 * 60_000

interface CatalogCache {
  readonly key: string
  readonly at: number
  readonly models: readonly LlmDiscoveredModel[]
}

/**
 * Host-owned request-time services the adapter can read without depending on the harness repo.
 */
export interface MojieAdapterOptions {
  /** Read the current live configuration for one request operation. */
  readonly config: () => ResolvedConfig
  /** Resolve one credential reference through the host seam. */
  readonly resolveApiKey: (ref: string) => Promise<string>
  readonly resolveAttachments?: () => AttachmentStore | undefined
  readonly resolveImageAccess?: ImageAttachmentAccessResolver
}

/**
 * Mojie Responses adapter.
 *
 * Timing model (one clock per failure mode, never a wall-clock cap on a live
 * stream):
 * - `firstByteTimeoutMs`: request sent → response headers. Catches a gateway
 *   that accepts the connection and never answers.
 * - `streamIdleTimeoutMs`: silence between received bytes. SSE comment
 *   heartbeats reset it, so a generation that keeps streaming may run for
 *   hours.
 * - `requestTimeoutMs`: optional operational backstop (`0` = off), never the
 *   liveness judge.
 */
export class MojieAdapter extends LlmAdapter {
  private catalog: CatalogCache | undefined
  private catalogRefresh: Promise<void> | undefined

  constructor(private readonly dependencies: MojieAdapterOptions) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mojie' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.dependencies.config()
    const apiKey = await this.dependencies.resolveApiKey(config.apiKeyEnv)
    const discovered = await this.loadCatalog(config, apiKey, false)
    return mergeCatalog(provider, config.models, discovered)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.dependencies.config()
    return this.resolveModelWith(provider, model, config, this.discoveredModel(config, model))
  }

  private resolveModelWith(
    provider: string,
    model: string,
    config: ResolvedConfig,
    discovered?: LlmDiscoveredModel,
  ): LlmResolvedModelInfo {
    const configured = config.models.find((entry) => entry.id === model)
    return mergeResolvedModelInfo(provider, model, configured, discovered)
  }

  /** Discovery row for one model from the last successful listing, when it still matches the endpoint. */
  private discoveredModel(config: ResolvedConfig, model: string): LlmDiscoveredModel | undefined {
    const cached = this.catalog
    if (cached === undefined || cached.key !== config.baseURL) return undefined
    return cached.models.find((entry) => entry.id === model)
  }

  private async loadCatalog(
    config: ResolvedConfig,
    apiKey: string,
    force: boolean,
  ): Promise<readonly LlmDiscoveredModel[]> {
    const cached = this.catalog
    if (!force
      && cached !== undefined
      && cached.key === config.baseURL
      && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.models
    }
    const models = await fetchModelListing(config.baseURL, apiKey)
    this.catalog = { key: config.baseURL, at: Date.now(), models }
    return models
  }

  /**
   * Refresh the advisory catalog off the request path. Metadata only affects
   * compaction and image handling, so a failed refresh must not fail a request.
   */
  private ensureCatalog(config: ResolvedConfig): void {
    const cached = this.catalog
    if (cached !== undefined && cached.key === config.baseURL && Date.now() - cached.at < CATALOG_TTL_MS) return
    if (this.catalogRefresh !== undefined) return
    this.catalogRefresh = (async () => {
      try {
        const apiKey = await this.dependencies.resolveApiKey(config.apiKeyEnv)
        await this.loadCatalog(config, apiKey, true)
      } catch {
        // Advisory metadata: keep serving built-in/configured values.
      } finally {
        this.catalogRefresh = undefined
      }
    })()
  }

  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return this.imageTarget(this.dependencies.config(), image)
  }

  private imageTarget(config: ResolvedConfig, image: ImageAttachmentRef) {
    return {
      ...requestImageDimensions(image.width, image.height, config.requestImagePixelBudget),
      maxBytes: config.requestImageMaxBytes,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('Mojie Responses does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One snapshot per request: a settings edit that lands mid-stream must not
    // mix two generations of endpoint, limits, and model metadata.
    const config = this.dependencies.config()
    const provider = this.resolveModelWith(
      options.provider,
      options.model,
      config,
      this.discoveredModel(config, options.model),
    )
    if (options.reasoningEffort !== undefined && provider.reasoning === undefined) {
      throw new LlmError(
        `provider "${options.provider}" model "${options.model}" does not support reasoning effort "${options.reasoningEffort}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    this.ensureCatalog(config)

    // The transport, clocks, SSE framing, and chunk translation are shared with
    // standalone consumers (src/core/stream.ts); the adapter only contributes the
    // DSH-specific image projection and request serialization.
    const apiKey = await this.dependencies.resolveApiKey(config.apiKeyEnv)
    yield* streamResponses({
      endpoint: responsesURL(config.baseURL),
      apiKey,
      firstByteTimeoutMs: config.firstByteTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      ...options.signal === undefined ? {} : { signal: options.signal },
      prepareBody: async (signal) => {
        const requestImages = await this.prepareRequestImages(options, provider, config, signal)
        return serializeRequest(
          { ...options, messages: this.projectOffloaded(options, requestImages) as RequestMessage[] },
          requestImages === undefined ? undefined : {
            requestImages,
            ...this.dependencies.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.dependencies.resolveImageAccess },
          },
        )
      },
    })
  }

  private async prepareRequestImages(
    options: GenerateOptions,
    model: LlmResolvedModelInfo,
    config: ResolvedConfig,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, RequestImageAttachment> | undefined> {
    if (!options.messages.some((message) => contentHasImage(message.content))) return undefined
    if (!model.inputModalities?.includes('image')) return undefined
    const attachments = this.dependencies.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('Mojie image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const refs = new Map<string, ImageAttachmentRef>()
    for (const message of options.messages) {
      for (const block of message.content) {
        if (block.type !== 'image' || block.offloaded === true) continue
        refs.set(block.attachment.attachmentId, block.attachment)
      }
    }
    const versions = new Map<string, RequestImageAttachment>()
    for (const ref of refs.values()) {
      versions.set(ref.attachmentId, await attachments.readImageRequest(ref, this.imageTarget(config, ref), signal))
    }
    const offloadImages = requiredImageOffload(
      options.messages,
      { representation: 'base64', maxBytes: config.maxRequestImageBytes },
      block => {
        const version = versions.get(block.attachment.attachmentId)
        if (version === undefined) return 0
        return version.bytes
      },
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `Mojie request images exceed the ${config.maxRequestImageBytes}-byte base64 budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        'IMAGE_OFFLOAD_REQUIRED',
        { offloadImages },
      )
    }
    return versions
  }

  private projectOffloaded(
    options: GenerateOptions,
    requestImages: ReadonlyMap<string, RequestImageAttachment> | undefined,
  ) {
    if (requestImages === undefined) return options.messages
    return projectOffloadedImages(options.messages, (ref) => {
      return offloadedImageText(ref, this.dependencies.resolveImageAccess?.(ref))
    })
  }
}
