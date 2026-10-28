/**
 * One decoded SSE event.
 */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * Parse a text/event-stream body into named events.
 *
 * `onActivity` fires for every chunk read off the wire, before framing, so
 * callers can implement a byte-level idle timeout: comment heartbeats (`: ping`)
 * produce no event but still prove the stream is alive.
 * @param body - response body stream.
 * @param onActivity - called on every received chunk, including comments.
 * @returns decoded SSE events in arrival order.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  const flush = (): SseEvent | undefined => {
    if (data.length === 0) return undefined
    const current = { ...event === undefined ? {} : { event }, data: data.join('\n') }
    event = undefined
    data = []
    return current
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const match = buffer.match(/\r?\n/)
        if (match === null) break
        const index = match.index ?? 0
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + match[0].length)
        if (line.length === 0) {
          const current = flush()
          if (current !== undefined) yield current
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const valueText = colon === -1 ? '' : line.slice(colon + 1).trimStart()
        if (field === 'event') event = valueText
        if (field === 'data') data.push(valueText)
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.length === 0) continue
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        else if (line.startsWith('event:')) event = line.slice(6).trimStart()
      }
    }
    const current = flush()
    if (current !== undefined) yield current
  } finally {
    await reader.cancel().catch(() => {})
  }
}
