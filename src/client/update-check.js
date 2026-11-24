/**
 * Plugin update check for the Mojie provider.
 *
 * DSH's plugin manager checks for updates only while the Plugins page is open,
 * so a plugin that wants to remind its users has to look at its own published
 * version. This module reads the `latest` dist-tag of the npm package from the
 * official registry and its mainland mirror, compares it with the version this
 * build was made from, and keeps the outcome in `localStorage` so the reminder
 * survives a reload without asking the registries again.
 *
 * The check is best-effort: no network, a blocked registry, or a malformed
 * answer only means "no reminder", never an error in a Session.
 *
 * @module @mojieai/dsh-mojie-model-provider/client/update-check
 */

/** npm package this plugin is published as. */
export const PACKAGE_NAME = '@mojieai/dsh-mojie-model-provider'

/** Registries asked in parallel; the highest answer wins. */
export const REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

/** Public package page, used by the reminder dialog. */
export const PACKAGE_PAGE = 'https://www.npmjs.com/package/@mojieai/dsh-mojie-model-provider'

/** Version this browser bundle was built from, injected by `scripts/build-client.mjs`. */
export const pluginVersion = typeof __MOJIE_VERSION__ === 'string' && __MOJIE_VERSION__.length > 0
  ? __MOJIE_VERSION__
  : '0.0.0'

/** `localStorage` key prefix shared by every stored field. */
const STORAGE_PREFIX = 'mojie.update.'

/** A successful check older than this asks again. */
const DEFAULT_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

/** A failed check older than this tries again. */
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000

/** Deadline for one registry read. */
const DEFAULT_TIMEOUT_MS = 8_000

/** Delay before the first check, so it never competes with the first render. */
const DEFAULT_FIRST_DELAY_MS = 2_500

/** Strict SemVer 2.0.0, with build metadata accepted and ignored. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Parse one version into comparable parts.
 * @param {string} text - version such as `0.3.2` or `0.4.0-rc.1`.
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]} | undefined} the parts, or `undefined` when unparsable.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return undefined
  const match = SEMVER.exec(text.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two versions by SemVer precedence.
 * @param {string} left - first version.
 * @param {string} right - second version.
 * @returns {-1 | 0 | 1 | undefined} `<0` when `left` is older, `0` when equal, `>0` when newer, `undefined` when either is unparsable.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  // A release outranks any prerelease of the same numbers.
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    // A shorter prerelease list has lower precedence when every shared part matches.
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX && numericY) return Number(x) < Number(y) ? -1 : 1
    // Numeric identifiers sort below alphanumeric ones.
    if (numericX) return -1
    if (numericY) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Whether `candidate` is a strictly newer release than `current`.
 * @param {string} candidate - published version.
 * @param {string} current - installed version.
 * @returns {boolean} true when the candidate is newer.
 */
export function isNewerVersion(candidate, current) {
  const order = compareVersions(candidate, current)
  return order !== undefined && order > 0
}

/**
 * Read one registry's `latest` dist-tag.
 * @param {string} registry - registry base URL without a trailing slash.
 * @param {object} settings - fetch implementation, package name, timeout, and caller signal.
 * @returns {Promise<{version: string, registry: string} | undefined>} the answer, or `undefined` on any failure.
 */
async function readRegistryLatest(registry, settings) {
  const { fetchImpl, packageName, timeoutMs, signal } = settings
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const forwardAbort = () => { controller.abort() }
  signal?.addEventListener?.('abort', forwardAbort, { once: true })
  if (signal?.aborted === true) controller.abort()
  try {
    // A scoped name keeps its `/` encoded: both registries accept `%2F` and
    // serve the version document for the tag.
    const url = `${registry.replace(/\/+$/u, '')}/${encodeURIComponent(packageName)}/latest`
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (response?.ok !== true) return undefined
    const body = await response.json()
    if (typeof body?.version !== 'string' || parseVersion(body.version) === undefined) return undefined
    // A deprecated tag still installs, but it is not worth a reminder.
    if (typeof body.deprecated === 'string' && body.deprecated.length > 0) return undefined
    return { version: body.version, registry }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forwardAbort)
  }
}

/**
 * Ask every registry in parallel and keep the newest answer.
 *
 * The two public registries can lag each other, so a single answer is not
 * enough: the highest valid version any of them publishes is the one users can
 * install.
 * @param {object} [options] - overrides for tests and embedders.
 * @returns {Promise<{version: string, registry: string} | undefined>} the newest published version.
 */
export async function fetchLatestVersion(options = {}) {
  const settings = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    packageName: options.packageName ?? PACKAGE_NAME,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  }
  if (typeof settings.fetchImpl !== 'function') return undefined
  const registries = options.registries ?? REGISTRIES
  const answers = await Promise.all(registries.map((registry) => readRegistryLatest(registry, settings)))
  let best
  for (const answer of answers) {
    if (answer === undefined) continue
    if (best === undefined || isNewerVersion(answer.version, best.version)) best = answer
  }
  return best
}

/**
 * Resolve the storage the reminder remembers its state in.
 * @param {Storage | null | undefined} storage - explicit storage, or `undefined` to use `localStorage`.
 * @returns {Storage | undefined} the storage, or `undefined` where the page has none.
 */
function resolveStorage(storage) {
  if (storage !== undefined) return storage ?? undefined
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // Privacy modes can throw on access.
    return undefined
  }
}

/**
 * Read one stored field.
 * @param {Storage | undefined} storage - storage that may be absent.
 * @param {string} key - field name without the prefix.
 * @returns {any} the parsed value, or `undefined`.
 */
function readStored(storage, key) {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(STORAGE_PREFIX + key)
    return raw === null || raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Write one stored field, ignoring a full or unavailable storage.
 * @param {Storage | undefined} storage - storage that may be absent.
 * @param {string} key - field name without the prefix.
 * @param {any} value - JSON-serializable value.
 * @returns {void}
 */
function writeStored(storage, key, value) {
  if (storage === undefined) return
  try {
    storage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
  } catch {
    // Remembering the reminder is not worth failing a page over.
  }
}

/**
 * Create the reminder state one page shares between its toast and the Models card.
 *
 * The snapshot is `{ phase, current, latest, available, dismissed, checkedAt,
 * failedAt }`. `available` means a newer release exists; the toast decides
 * whether to show it by comparing `dismissed` with `latest`.
 * @param {object} [options] - overrides for tests and embedders.
 * @returns {object} the store: `getSnapshot`, `subscribe`, `check`, `start`, `dismiss`, `dispose`.
 */
export function createUpdateStore(options = {}) {
  const current = options.current ?? pluginVersion
  const storage = resolveStorage(options.storage)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const registries = options.registries ?? REGISTRIES
  const packageName = options.packageName ?? PACKAGE_NAME
  const now = options.now ?? (() => Date.now())
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const firstDelayMs = options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS

  const storedLatest = readStored(storage, 'latest')
  const storedCheckedAt = Number(readStored(storage, 'checkedAt')) || 0
  const storedFailedAt = Number(readStored(storage, 'failedAt')) || 0
  const storedDismissed = readStored(storage, 'dismissed')

  let state = {
    current,
    latest: typeof storedLatest === 'string' ? storedLatest : undefined,
    available: typeof storedLatest === 'string' && isNewerVersion(storedLatest, current),
    dismissed: typeof storedDismissed === 'string' ? storedDismissed : undefined,
    phase: 'idle',
    checkedAt: storedCheckedAt,
    failedAt: storedFailedAt,
  }
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let controller
  let timer
  let disposed = false

  /** Publish one snapshot change to every subscriber. */
  const publish = (patch) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  /** Whether the last attempt is old enough to repeat. */
  const shouldCheck = () => {
    const stamp = Math.max(state.checkedAt, state.failedAt)
    if (stamp === 0) return true
    const wait = state.failedAt > state.checkedAt ? retryIntervalMs : checkIntervalMs
    return now() - stamp >= wait
  }

  const store = {
    /** Current reminder state. */
    getSnapshot: () => state,

    /**
     * Observe state changes.
     * @param {() => void} listener - called after each change.
     * @returns {() => void} unsubscribe.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /**
     * Stop reminding about the release the user dismissed.
     * @returns {void}
     */
    dismiss() {
      if (state.latest === undefined) return
      writeStored(storage, 'dismissed', state.latest)
      publish({ dismissed: state.latest })
    },

    /**
     * Read the registries once unless a recent answer says otherwise.
     * @param {{force?: boolean}} [options] - `force` asks even when a cached answer is fresh.
     * @returns {Promise<object>} the resulting snapshot.
     */
    async check({ force = false } = {}) {
      if (disposed || state.phase === 'checking') return state
      if (!force && !shouldCheck()) return state
      publish({ phase: 'checking' })
      const inner = new AbortController()
      controller = inner
      const answer = await fetchLatestVersion({ fetchImpl, registries, packageName, timeoutMs, signal: inner.signal })
      if (disposed || controller !== inner) return state
      controller = undefined
      const stamp = now()
      if (answer === undefined) {
        writeStored(storage, 'failedAt', stamp)
        publish({ phase: 'failed', failedAt: stamp })
        return state
      }
      writeStored(storage, 'latest', answer.version)
      writeStored(storage, 'checkedAt', stamp)
      publish({
        phase: 'done',
        latest: answer.version,
        checkedAt: stamp,
        available: isNewerVersion(answer.version, current),
      })
      return state
    },

    /**
     * Schedule the page-load check.
     * @param {{delayMs?: number}} [options] - delay override, mainly for tests.
     * @returns {() => void} cancels the timer and any running request.
     */
    start({ delayMs = firstDelayMs } = {}) {
      if (disposed || timer !== undefined) return () => {}
      if (!shouldCheck()) return () => {}
      timer = setTimeout(() => {
        timer = undefined
        void store.check()
      }, delayMs)
      return () => { store.dispose() }
    },

    /**
     * Release timers, listeners, and an in-flight request.
     * @returns {void}
     */
    dispose() {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      controller?.abort()
      controller = undefined
      listeners.clear()
    },
  }
  return store
}
