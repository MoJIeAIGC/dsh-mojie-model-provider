import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey } from './credential.js'

/**
 * The one construction of headers for a Mojie API request.
 *
 * This plugin is its own provider adapter: it owns the wire, so it also owns
 * how a resolved key becomes an `Authorization` header. Nothing here comes from
 * `@deepseek-ai/dsh-llm-deepseek` (the first-party DeepSeek transport, whose
 * `resolveAuth`/`authHeaders` hooks are internal to that family) — the harness
 * contract for a third-party adapter is only that every provider request
 * carries {@link attributionHeaders} plus whatever the provider needs.
 *
 * Centralizing it keeps the three callers from drifting: the chat stream, model
 * discovery, and the media gateway all send the same auth pair, and a future
 * header scheme (for example `x-api-key` or an extra beta header) changes one
 * place instead of three.
 */

/** Optional inputs for {@link mojieAuthHeaders}. */
export interface MojieAuthOptions {
  /**
   * Headers merged after the auth pair. A caller may override `authorization`
   * here, which is how a test or an embedder reproduces a provider variant.
   */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Credential reference named in a rejected-key diagnostic, such as
   * `MOJIE_API_KEY`. Defaults to `apiKey`, the standalone client's option name.
   */
  readonly ref?: string
}

/**
 * Build the headers one Mojie API request carries.
 *
 * The key is validated here rather than at each caller, so a blank or
 * untransportable key is reported with the same `INVALID_CREDENTIAL`
 * diagnostic on every path, before any network I/O. Header names are lowercase
 * because HTTP field names are case-insensitive and the harness's own
 * {@link attributionHeaders} uses that form.
 * @param apiKey - raw key as configured, stored, or typed; trimmed here.
 * @param options - extra headers and the diagnostic reference.
 * @returns ready-to-send headers: attribution, `authorization: Bearer <key>`,
 * then the caller's extras.
 * @throws {LlmError} `INVALID_CREDENTIAL` when the key cannot be sent.
 */
export async function mojieAuthHeaders(apiKey: string, options: MojieAuthOptions = {}): Promise<Record<string, string>> {
  // The credential predicate is the running harness's (see `credential.ts`), so
  // binding it is async: `@deepseek-ai/dsh-credentials` is probed once and may
  // simply not exist on the host.
  const usable = await assertUsableApiKey(apiKey, 'mojie', options.ref ?? 'apiKey')
  return {
    ...attributionHeaders(),
    'authorization': `Bearer ${usable}`,
    ...options.headers ?? {},
  }
}
