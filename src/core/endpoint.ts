import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Endpoint helpers shared by the provider adapter and standalone consumers.
 *
 * Kept free of cordis and Schemastery so a plugin that only wants to talk to
 * Mojie can import them without pulling the provider plugin's config surface.
 */

/**
 * Normalize a Mojie site root to the canonical origin-only form.
 * Accepts the plain origin and the same origin with a trailing `/v1`.
 * @param raw - configured base URL.
 * @returns canonical HTTPS root without a trailing slash.
 */
export function normalizeBaseURL(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (cause) {
    throw new LlmError(`invalid Mojie baseURL "${raw}"`, 'INVALID_CONFIG', { cause: cause as Error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LlmError(`Mojie baseURL must use HTTP(S), got ${parsed.protocol}`, 'INVALID_CONFIG')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new LlmError('Mojie baseURL must not include credentials, query, or fragment', 'INVALID_CONFIG')
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/v1') {
    throw new LlmError(`Mojie baseURL must be the site root or the same root with /v1, got "${parsed.pathname}"`, 'INVALID_CONFIG')
  }
  return parsed.origin
}

/**
 * Build the fixed Mojie Responses endpoint from a normalized base URL.
 * @param baseURL - canonical site root.
 * @returns `/v1/Responses` URL.
 */
export function responsesURL(baseURL: string): string {
  return `${normalizeBaseURL(baseURL)}/v1/Responses`
}

/**
 * Build the fixed Mojie models endpoint from a normalized base URL.
 * @param baseURL - canonical site root.
 * @returns `/v1/models` URL.
 */
export function modelsURL(baseURL: string): string {
  return `${normalizeBaseURL(baseURL)}/v1/models`
}
