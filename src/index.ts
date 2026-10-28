/**
 * Mojie model-provider plugin for DeepSeek Harness.
 * @module @mojieai/dsh-mojie-model-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { MojieAdapter } from './adapter.js'
import { registerImageCommand } from './commands/image.js'
import {
  Config, normalizeConfig, plainOptions, type Config as PluginConfig, type ResolvedConfig,
} from './config.js'
import { discoverDraftModels } from './discovery.js'
import { MEDIA_MODELS_DISCOVERY_API, MojieMediaClient } from './media/client.js'
import { MojieService } from './service.js'
import { registerImageTools } from './tools/image.js'

/** Settings namespace shared by the provider directory, discovery, and the Models page card. */
export const SETTINGS_NS = 'mojie'

export { Config, normalizeConfig }
export type { Config as PluginConfig, MojieModelConfig } from './config.js'

/**
 * Public API for other plugins — chat side.
 *
 * `ctx.mojie` is the configured route (this plugin's key, baseURL, and clocks);
 * `MojieClient` is the same capability without the plugin, for a caller that
 * brings its own endpoint and credential. `builtinModel` and `fetchModelListing`
 * expose the shipped catalog and the raw discovery call.
 */
export { MojieClient } from './core/client.js'
export type {
  MojieChatMessage, MojieChatRequest, MojieChatResult, MojieClientOptions, MojieContent,
} from './core/client.js'
export { MOJIE_SERVICE, MojieService } from './service.js'
export type { MojieChatTextOptions, MojieServiceOptions } from './service.js'
export { builtinModel } from './catalog.js'
export type { MojieCatalogModel } from './catalog.js'
export { fetchModelListing } from './discovery.js'

/**
 * Public API for other plugins — image side.
 *
 * `MojieMediaClient` is the `/v1/media` task client the native tools and
 * `/image` both use, so a caller can own a task (different key, background job,
 * tests) without the tool registry. The registrars exist for embedders that
 * mount the capability under their own services.
 */
export { MojieMediaClient, MEDIA_MODELS_DISCOVERY_API, sniffImageMediaType } from './media/client.js'
export type {
  MojieMediaClientOptions, MojieMediaImage, MojieMediaRequest, MojieMediaTask,
} from './media/client.js'
export { registerImageTools } from './tools/image.js'
export type { MojieImageToolOptions } from './tools/image.js'
export { IMAGE_COMMAND_NAME, registerImageCommand } from './commands/image.js'
export type { ImageCommandOptions } from './commands/image.js'
export { DEFAULT_IMAGE_MODEL } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The Mojie client service, provided while this provider plugin is loaded.
     * Consumers declare `inject: ['mojie']` and call `ctx.mojie.chat(...)`,
     * `ctx.mojie.client()`, `ctx.mojie.chatText(...)`, or `ctx.mojie.listModels()`.
     */
    mojie: MojieService
  }
}

/** Display name used in diagnostics; optional metadata. */
export const name = 'dsh-mojie-model-provider'

/**
 * Services this plugin requires before it activates. `llm` provides
 * `ctx.llm.registerAdapter`, which is the only contribution this plugin makes.
 * Loading order is derived from these dependencies, not file order.
 */
export const inject = ['llm']

/**
 * Provider route ids this plugin claims. A provider route maps to exactly one adapter,
 * so registering a second adapter for the same route is an error the harness rejects.
 */
export const PROVIDER_ROUTES = ['mojie']

/** Credential seam owned by the host; the Models page writes keys through it. */
interface CredentialsService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Resolve one credential reference through the host credential seam, falling
 * back to the process environment for deployments that only export the key.
 * @param ctx - plugin context used to reach the optional credentials service.
 * @param ref - credential reference such as `MOJIE_API_KEY`.
 * @returns the trimmed, usable credential.
 * @throws {LlmError} `MISSING_CREDENTIAL` when nothing supplies the reference.
 */
export async function resolveCredential(ctx: Context, ref: string): Promise<string> {
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  const stored = credentials === undefined ? undefined : (await credentials.resolve(ref))?.value
  const value = stored ?? process.env[ref]
  if (value === undefined || value.length === 0) {
    throw new LlmError(
      `mojie: no credential for "${ref}"; store it through the credentials service (the Models page writes it) or export it`,
      'MISSING_CREDENTIAL',
    )
  }
  return assertUsableApiKey(value, 'mojie', ref)
}

/**
 * Build the Mojie adapter from validated plugin configuration.
 * @param config - parsed volatile plugin configuration.
 * @param ctx - plugin context used to resolve optional host services.
 * @returns the adapter serving the Mojie route.
 */
export function createAdapter(config: PluginConfig, ctx: Context): LlmAdapter {
  const readConfig = (): ResolvedConfig => normalizeConfig(plainOptions(config))
  return new MojieAdapter({
    config: readConfig,
    resolveApiKey: (ref) => resolveCredential(ctx, ref),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (ref) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return undefined
      return resolveImageAttachmentAccess(
        attachments,
        (hostPath) => {
          const fs = ctx.get('fs') as { processPathFromHostPath(hostPath: string): string | undefined } | undefined
          return fs?.processPathFromHostPath(hostPath)
        },
        ref,
      )
    },
  })
}

/**
 * Plugin body: registers the Mojie provider route, the configurable-provider
 * directory entry, and the draft model discovery on `ctx.llm` as effects.
 * @param ctx - registrant context carrying the `llm` service declared in {@link inject}.
 * @param config - parsed volatile plugin configuration.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const initial = plainOptions(config)
  // The settings namespace is the profile entry id. The bundle patch pins
  // `id: mojie`; a hand-written mount must do the same for the Models card and
  // settings writes to address the running entry.
  const entryId = (ctx.fiber as unknown as {
    entry?: { options?: { id?: string } }
  }).entry?.options?.id
  if (entryId !== undefined && entryId !== SETTINGS_NS) {
    ctx.logger.warn(
      `mojie: mount this provider with entry id "${SETTINGS_NS}" so the Models page can edit it`
      + ` (got "${entryId}")`,
    )
  }
  const adapter = createAdapter(config, ctx)
  // Other plugins reach this capability through `ctx.mojie` (inject: ['mojie']).
  // The service registers itself on this context, so its lifetime is this
  // plugin's fiber and it disappears when the plugin unloads.
  new MojieService(ctx, {
    config: () => normalizeConfig(plainOptions(config)),
    resolveApiKey: (ref) => resolveCredential(ctx, ref),
    provider: PROVIDER_ROUTES[0]!,
  })
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER_ROUTES[0]!,
    displayName: 'Mojie',
    settingsNs: SETTINGS_NS,
    settingsPath: [],
    defaultBaseURL: initial.baseURL,
  }])
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
    const current = normalizeConfig(plainOptions(config))
    const apiKey = request.apiKey ?? await resolveCredential(ctx, current.apiKeyEnv)
    // The Settings card reuses this one discovery surface for its image-model
    // dropdown: the marker selects `/v1/media/models` instead of chat models.
    if (request.api === MEDIA_MODELS_DISCOVERY_API) {
      const media = new MojieMediaClient({ baseURL: request.baseURL ?? current.baseURL, apiKey })
      return (await media.listModels(signal)).map((id) => ({ id }))
    }
    return discoverDraftModels(current, { ...request, apiKey }, signal)
  })
  ctx.effect(() => ctx.llm.registerAdapter([...PROVIDER_ROUTES], adapter))

  // Native image generation. These registrations are optional services: the
  // provider route keeps working in compositions without a tool registry, a
  // command registry, or a skill registry, and each one disappears with the
  // plugin's fiber.
  const readConfig = (): ResolvedConfig => normalizeConfig(plainOptions(config))
  const media = async (): Promise<MojieMediaClient> => {
    const current = readConfig()
    return new MojieMediaClient({
      baseURL: current.baseURL,
      apiKey: await resolveCredential(ctx, current.apiKeyEnv),
      pollIntervalMs: current.imagePollIntervalMs,
      taskTimeoutMs: current.imageTaskTimeoutMs,
      downloadMaxBytes: current.imageDownloadMaxBytes,
    })
  }
  if (initial.imageTools) {
    ctx.inject(['tools'], (scoped) => {
      registerImageTools(scoped, {
        config: readConfig,
        media,
        attachments: () => scoped.get('attachments'),
      })
    })
    // `/image` is the human entry: it talks to the media gateway directly, so the
    // prompt is not rewritten and the chosen model is honored per call.
    ctx.inject(['commands'], (scoped) => {
      registerImageCommand(scoped, {
        config: readConfig,
        media,
        attachments: () => scoped.get('attachments'),
        settingsNamespace: SETTINGS_NS,
      })
    })
  }
}
