/**
 * Mojie model-provider plugin — DeepSeek Harness (dsh) plugin skeleton.
 *
 * Mojie (mojieaigc.com) exposes an OpenAI-compatible model gateway. This plugin owns the
 * `mojie` provider route: it registers one `LlmAdapter` that turns harness `GenerateOptions`
 * into `/v1/chat/completions` requests and translates the returned SSE frames back into
 * harness `StreamChunk`s.
 *
 * Conventions this skeleton already follows:
 * - function-plugin shape with named exports `name` / `inject` / `Config` / `apply`,
 *   and no default export;
 * - every contribution is registered on `ctx` as an effect, so unload/HMR rolls it back;
 * - deployment choices are validated `Config` fields, never hardcoded tunables.
 *
 * Not implemented yet: the adapter itself (request serialization, SSE translation, error
 * classification). See `createAdapter` for the single seam to fill in.
 *
 * @module @dsh-dev/dsh-mojie-model-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

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

/** Deployment configuration for the Mojie model provider. */
export interface Config {
  /** Mojie API key, sent as `Authorization: Bearer <apiKey>` on every request. */
  apiKey: string
  /** API root shared by the LLM and media endpoints, without a trailing slash. */
  baseURL: string
  /** Model ids this route advertises, in the order the GUI shows them. */
  models: string[]
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number
}

/** Schemastery configuration schema; the harness validates the entry config against it. */
export const Config: z<Config> = z.object({
  apiKey: z.string().required(),
  baseURL: z.string().default('https://mojieaigc.com/v1'),
  models: z.array(z.string()).default([]),
  requestTimeoutMs: z.number().default(120_000),
})

/**
 * Adapter factory hook — the one seam this skeleton leaves open.
 * @param _config - validated plugin configuration.
 * @returns the `LlmAdapter` to register for {@link PROVIDER_ROUTES}, or `undefined` to skip registration.
 */
export function createAdapter(_config: Config): LlmAdapter | undefined {
  // TODO: return a `MojieAdapter` (see `packages/llm/llm-deepseek/src/adapter.ts` in the
  // harness repo for the reference implementation): serialize `GenerateOptions` into a
  // `/v1/chat/completions` body, stream the SSE response, and yield `StreamChunk`s.
  return undefined
}

/**
 * Plugin body: registers the Mojie provider route on `ctx.llm` as an effect.
 * @param ctx - registrant context carrying the `llm` service declared in {@link inject}.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = createAdapter(config)
  if (adapter === undefined) {
    ctx.logger.info('[mojie] adapter not implemented yet; provider route left unregistered')
    return
  }

  // Registration is an effect, so unloading the plugin withdraws the route.
  ctx.effect(() => ctx.llm.registerAdapter([...PROVIDER_ROUTES], adapter))
}
