import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'

/**
 * Summarize provider error fields used for stable classification.
 * @param raw - decoded response body.
 * @returns combined detail text.
 */
export function providerErrorDetail(raw: unknown): string {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as Record<string, unknown> : envelope
  return [error.type, error.code, error.message].filter((value): value is string => typeof value === 'string').join(' ')
}

/**
 * Parse the provider's retry hint when present.
 * @param headers - response headers.
 * @returns retry delay in milliseconds when valid.
 */
export function retryAfterMs(headers?: Headers): number | undefined {
  const raw = headers?.get('retry-after')
  if (raw == null) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const value = Number(raw) * 1000
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const value = Date.parse(raw) - Date.now()
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Recognize context-overflow wording the canonical classifier misses.
 *
 * Anthropic-backed relays answer `prompt is too long: 1764269 tokens > 1000000
 * maximum`, which names no "context" noun. Checked after the shared classifier
 * so both HTTP-status errors and in-stream failures classify identically.
 * @param detail - provider code/type/message text joined into one string.
 * @returns true when the detail reports an oversized prompt.
 */
export function isContextOverflowDetail(detail: string): boolean {
  if (isContextWindowExceededError(detail)) return true
  return /\btokens?\s*>\s*\d+\s*(?:token\s*)?maximum\b/iu.test(detail)
    || /\b(?:prompt|input|request)\s+(?:is\s+)?too\s+(?:long|large)\b/iu.test(detail)
}

/**
 * Classify a Mojie HTTP failure into DSH's provider-neutral error taxonomy.
 * @param raw - decoded response body when available.
 * @param status - observed HTTP status.
 * @param headers - response headers.
 * @returns typed LLM error.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const detail = providerErrorDetail(raw)
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as Record<string, unknown> : envelope
  const message = typeof error.message === 'string'
    ? error.message
    : `Mojie request failed (${status ?? 'stream error'})`
  let code: string
  if (status === 401 || status === 403) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = QUOTA_EXCEEDED_CODE
  else if (status === 429) code = 'RATE_LIMIT'
  else if (isContextOverflowDetail(detail)) code = CONTEXT_WINDOW_EXCEEDED_CODE
  else if (status === 400 || status === 413) code = 'INVALID_REQUEST'
  else if (status !== undefined && status >= 500) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const requestId = headers?.get('x-request-id') ?? headers?.get('request-id')
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...requestId == null || requestId.length === 0 ? {} : { requestId: ProviderRequestId(requestId) },
    ...retryAfterMs(headers) === undefined ? {} : { providerRetryAfterMs: retryAfterMs(headers)! },
  })
}
