/**
 * Framework-free Mojie client surface.
 *
 * Import from `@mojieai/dsh-mojie-model-provider/core` when you want a client
 * with your own endpoint and credential: no cordis context, no plugin config,
 * no `ctx.llm`. The provider plugin's adapter and the `ctx.mojie` service are
 * both built on this layer.
 *
 * @module @mojieai/dsh-mojie-model-provider/core
 */

export { MojieClient } from './client.js'
export type {
  MojieChatMessage,
  MojieChatRequest,
  MojieChatResult,
  MojieClientOptions,
  MojieContent,
} from './client.js'
export { modelsURL, normalizeBaseURL, responsesURL } from './endpoint.js'
export { streamResponses } from './stream.js'
export type { ResponsesStreamOptions } from './stream.js'
export { builtinModel } from '../catalog.js'
export type { MojieCatalogModel } from '../catalog.js'
export { fetchModelListing } from '../discovery.js'
