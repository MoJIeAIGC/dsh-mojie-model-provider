/**
 * Deterministic model ordering shared by the host catalog and the browser card.
 *
 * The composer lists models in the order the provider returns them, and new
 * models are appended to the stored `models` list — which left something like
 * `gpt-6.1-terra` at the very bottom instead of among the other GPT models.
 * This module orders by display name with numeric segments compared as numbers
 * (`gpt-5.9` before `gpt-5.10`), then by id, so the order is stable across Node
 * and browsers and one vendor's models stay adjacent.
 *
 * @module @mojieai/dsh-mojie-model-provider/order
 */

/** The minimum shape a row needs to be ordered. */
export interface OrderedModel {
  /** Exact provider model id. */
  readonly id: string
  /** Display name shown by selectors; falls back to the id. */
  readonly name?: string
}

const CHUNK = /\d+|\D+/gu

/**
 * Split a name into digit and non-digit runs.
 * @param value - lowercased name.
 * @returns alternating chunks.
 */
function chunks(value: string): string[] {
  return value.match(CHUNK) ?? []
}

/**
 * Compare two strings naturally: text case-insensitively, digit runs as numbers.
 * @param left - first value.
 * @param right - second value.
 * @returns negative, zero, or positive.
 */
function compareNatural(left: string, right: string): number {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  if (a === b) return left === right ? 0 : left < right ? -1 : 1
  const ac = chunks(a)
  const bc = chunks(b)
  const length = Math.min(ac.length, bc.length)
  for (let index = 0; index < length; index += 1) {
    const x = ac[index]!
    const y = bc[index]!
    const xNumeric = /^\d/u.test(x)
    const yNumeric = /^\d/u.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference < 0 ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (ac.length !== bc.length) return ac.length - bc.length
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Order two model rows by display name, then id.
 * @param left - first row.
 * @param right - second row.
 * @returns negative, zero, or positive.
 */
export function compareModelOrder(left: OrderedModel, right: OrderedModel): number {
  const byName = compareNatural(left.name ?? left.id, right.name ?? right.id)
  return byName !== 0 ? byName : compareNatural(left.id, right.id)
}

/**
 * Sort rows into the selector's display order without mutating the input.
 * @param models - rows to order.
 * @returns a sorted copy.
 */
export function sortModelOrder<T extends OrderedModel>(models: readonly T[]): T[] {
  return [...models].sort(compareModelOrder)
}
