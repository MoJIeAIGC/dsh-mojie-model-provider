import { attributionHeaders, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseSse } from '../sse.js'
import { providerError } from '../transport.js'
import { translate } from '../translate.js'

/**
 * One streaming `/v1/Responses` exchange, independent of cordis and of the
 * provider adapter.
 *
 * Timing model (one clock per failure mode, never a wall-clock cap on a live
 * stream):
 * - `firstByteTimeoutMs`: request sent → response headers. Catches a gateway
 *   that accepts the connection and never answers.
 * - `streamIdleTimeoutMs`: silence between received bytes. SSE comment
 *   heartbeats reset it, so a generation that keeps streaming may run for hours.
 * - `requestTimeoutMs`: optional operational backstop (`0` = off), never the
 *   liveness judge.
 */
export interface ResponsesStreamOptions {
  /** Full `/v1/Responses` endpoint URL. */
  readonly endpoint: string
  /** Raw API key; sent as `Authorization: Bearer <key>`. */
  readonly apiKey: string
  /**
   * Build the JSON request body. Runs after the backstop clock starts and before
   * the header clock, so request preparation (image derivation, serialization)
   * is bounded by the backstop without eating the gateway's response budget.
   */
  readonly prepareBody: (signal: AbortSignal) => Promise<unknown>
  /** Header deadline in milliseconds; defaults to 60s. */
  readonly firstByteTimeoutMs?: number
  /** Maximum silence between received bytes; defaults to 90s. */
  readonly streamIdleTimeoutMs?: number
  /** Whole-exchange backstop in milliseconds; `0` (default) disables it. */
  readonly requestTimeoutMs?: number
  /** Caller cancellation, composed with the internal clocks. */
  readonly signal?: AbortSignal
  /** Fetch implementation, injectable for tests and custom transports. */
  readonly fetchImpl?: typeof fetch
  /** Extra request headers merged over the defaults. */
  readonly headers?: Readonly<Record<string, string>>
}

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000

/**
 * Stream one Mojie Responses call as DSH stream chunks.
 *
 * Throws {@link LlmError} with `TIMEOUT` (header/idle/backstop), `ABORTED`,
 * `TRANSPORT`, or the provider-classified code from the HTTP status or the
 * in-stream `response.failed` frame.
 * @param options - endpoint, credential, body builder, and clocks.
 * @returns translated stream chunks.
 */
export async function* streamResponses(options: ResponsesStreamOptions): AsyncIterable<StreamChunk> {
  const fetchImpl = options.fetchImpl ?? fetch
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? 0

  const abortController = new AbortController()
  const headerController = new AbortController()
  const capController = requestTimeoutMs > 0 ? new AbortController() : undefined
  let headersTimedOut = false
  let idleTimedOut = false
  let capExceeded = false
  let headerTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined
  const capTimer = capController === undefined
    ? undefined
    : setTimeout(() => {
      capExceeded = true
      capController.abort()
    }, requestTimeoutMs)

  const signals = [abortController.signal, headerController.signal]
  if (options.signal !== undefined) signals.push(options.signal)
  if (capController !== undefined) signals.push(capController.signal)
  const requestSignal = AbortSignal.any(signals)

  try {
    const body = await options.prepareBody(requestSignal)
    // The header clock starts once the body is ready to send.
    headerTimer = setTimeout(() => {
      headersTimedOut = true
      headerController.abort()
    }, firstByteTimeoutMs)
    let response: Response
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        signal: requestSignal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'authorization': `Bearer ${options.apiKey}`,
          ...options.headers,
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      if (options.signal?.aborted) throw new LlmError('Mojie Responses request aborted', 'ABORTED', { cause: cause as Error })
      if (headersTimedOut) {
        throw new LlmError(
          `Mojie Responses sent no response headers within ${firstByteTimeoutMs}ms`,
          'TIMEOUT',
          { cause: cause as Error },
        )
      }
      if (capExceeded) {
        throw new LlmError(
          `Mojie Responses exceeded the ${requestTimeoutMs}ms request backstop`,
          'TIMEOUT',
          { cause: cause as Error },
        )
      }
      throw new LlmError('Mojie Responses transport failed', 'TRANSPORT', { cause: cause as Error })
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer)
    }
    if (!response.ok) {
      let raw: unknown
      try { raw = JSON.parse(await response.text()) } catch { raw = undefined }
      throw providerError(raw, response.status, response.headers)
    }
    if (response.body === null) {
      throw new LlmError('Mojie Responses returned no response body', 'EMPTY_RESPONSE')
    }

    // Byte-level idle watchdog: every received chunk (including SSE comment
    // heartbeats) proves liveness, so a long generation is never cut short by
    // its total duration.
    let lastActivity = Date.now()
    const onActivity = (): void => { lastActivity = Date.now() }
    const tickMs = Math.max(5, Math.min(1000, Math.floor(streamIdleTimeoutMs / 4)))
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < streamIdleTimeoutMs) return
      idleTimedOut = true
      abortController.abort()
    }, tickMs)

    const iterator = translate(parseSse(response.body, onActivity))[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      await iterator.return?.(undefined).catch(() => {})
    }
  } catch (error) {
    if (idleTimedOut) {
      throw new LlmError(
        `Mojie Responses stream idle timeout: no bytes for ${streamIdleTimeoutMs}ms`,
        'TIMEOUT',
        { cause: error as Error },
      )
    }
    if (capExceeded) {
      throw new LlmError(
        `Mojie Responses exceeded the ${requestTimeoutMs}ms request backstop`,
        'TIMEOUT',
        { cause: error as Error },
      )
    }
    if (options.signal?.aborted) {
      throw new LlmError('Mojie Responses request aborted', 'ABORTED', { cause: error as Error })
    }
    throw error
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer)
    if (idleTimer !== undefined) clearInterval(idleTimer)
    if (capTimer !== undefined) clearTimeout(capTimer)
    abortController.abort()
  }
}
