import * as llm from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Credential seam that follows whichever package currently owns the rule.
 *
 * The harness exported `assertUsableApiKey` from `@deepseek-ai/dsh-llm` through
 * the 0.2.2 line, then moved the predicate to `@deepseek-ai/dsh-credentials`
 * (as `normalizeApiKey`) in the 0.2.3-alpha line. A missing *named* export is an
 * ESM link error — the entry dies before any of this plugin's code runs — so
 * neither location may be a hard import, and the rule must not be frozen here:
 * a copy would silently diverge the first time the owning package changes it.
 *
 * `@deepseek-ai/dsh-llm` is imported as a namespace (which always links) and
 * probed synchronously; `@deepseek-ai/dsh-credentials` does not exist on every
 * host, so it is loaded through a dynamic import that is allowed to fail and is
 * cached either way. The order is the order the harness has shipped the rule:
 *
 * 1. `dsh-llm.assertUsableApiKey` — the 0.2.2 convenience wrapper, which already
 *    throws the harness's own `INVALID_CREDENTIAL` diagnostic.
 * 2. `dsh-llm.normalizeApiKey` — the verdict shape some releases ship instead.
 * 3. `dsh-credentials.normalizeApiKey` — the current home of the rule.
 * 4. Neither — fall back to the transport invariant below, which is a property
 *    of HTTP rather than of any one harness release.
 *
 * Cases 2 and 3 share one verdict mapper, so the diagnostic wording (and the
 * `INVALID_CREDENTIAL` code, which `dsh-llm` still exports) stays this plugin's.
 * Case 4 is the only code that can go stale, and it can only go stale in the
 * direction of accepting a key the harness would reject (or vice versa) — never
 * in the direction of failing to load.
 */

/** One supplied credential judged, returning it trimmed or throwing the diagnostic. */
export type ApiKeyCheck = (raw: string, pkg: string, ref: string) => string

/** Members this seam probes. Every one is optional: absence is the normal case. */
interface CredentialHost {
  readonly assertUsableApiKey?: unknown
  readonly normalizeApiKey?: unknown
}

/** Verdict shape of `normalizeApiKey` in the packages that export it. */
type NormalizedKey = { readonly ok: true, readonly value: string } | { readonly ok: false, readonly reason: string }

/**
 * Bare specifier kept in a variable because the package is host-provided:
 * naming it literally would make the compiler require a dependency the plugin
 * must not have (it is absent on every harness before 0.2.3).
 */
const CREDENTIALS_PACKAGE = '@deepseek-ai/dsh-credentials'

/**
 * Characters an HTTP header carries verbatim and every known provider key uses:
 * printable ASCII, space excluded. A key outside this set cannot reach any
 * provider — `fetch` refuses to build the header — so this is a transport
 * invariant rather than one provider's policy. Latin-1 is excluded
 * deliberately: a header could carry it, but no provider issues it, and
 * admitting it trades a local explained refusal for an opaque 401.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * The blank-key diagnostic. Absence of a key is a different failure the caller
 * reports itself (`MISSING_CREDENTIAL`), because the fix is to supply one. The
 * key never enters the message: `ref` names where to fix it, so no part of a
 * secret reaches a log or the UI.
 */
function blankKey(pkg: string, ref: string): LlmError {
  return new LlmError(
    `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key (the web Models page writes it) or export it in the launching environment`,
    'INVALID_CREDENTIAL',
  )
}

/** The header-hostile diagnostic, with the same no-echo rule as {@link blankKey}. */
function illegalKey(pkg: string, ref: string): LlmError {
  return new LlmError(
    `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry; set ${ref} to the raw key alone (the web Models page writes it)`,
    'INVALID_CREDENTIAL',
  )
}

/**
 * Judge one supplied credential using the transport invariant alone.
 *
 * Trimming is silent because a padded key has one unambiguous reading; every
 * other defect is reported. This is the last resort used only when the running
 * harness offers no credential predicate of its own.
 * @param raw - the credential exactly as configured, stored, or typed.
 * @param pkg - the refusing package name, prefixed to the diagnostic.
 * @param ref - the credential reference the value resolved through.
 * @returns the trimmed, usable key.
 * @throws {LlmError} `INVALID_CREDENTIAL` when the key is blank or cannot be
 * transported in an HTTP header.
 */
export function localApiKeyCheck(raw: string, pkg: string, ref: string): string {
  const value = raw.trim()
  if (value.length === 0) throw blankKey(pkg, ref)
  if (!LEGAL_API_KEY.test(value)) throw illegalKey(pkg, ref)
  return value
}

/**
 * The predicate one host module offers, if it offers one.
 * @param host - a `@deepseek-ai/*` module namespace (or any object).
 * @returns the bound check, or `undefined` when the host has no opinion.
 */
function checkFromHost(host: unknown): ApiKeyCheck | undefined {
  const probes = (host ?? {}) as CredentialHost
  const assert = probes.assertUsableApiKey
  if (typeof assert === 'function') {
    return (raw, pkg, ref) => (assert as ApiKeyCheck)(raw, pkg, ref)
  }
  const normalize = probes.normalizeApiKey
  if (typeof normalize === 'function') {
    return (raw, pkg, ref) => {
      const checked = (normalize as (value: string) => NormalizedKey)(raw)
      if (checked.ok) return checked.value
      throw checked.reason === 'empty' ? blankKey(pkg, ref) : illegalKey(pkg, ref)
    }
  }
  return undefined
}

/**
 * Bind the first host that offers a predicate, in the caller's order.
 *
 * Exported for tests and for embedders that mount this plugin against a
 * hand-assembled module set; production calls {@link apiKeyCheck}.
 * @param hosts - module namespaces to probe, most authoritative first.
 * @returns the first available check, or {@link localApiKeyCheck}.
 */
export function pickApiKeyCheck(hosts: readonly unknown[]): ApiKeyCheck {
  for (const host of hosts) {
    const check = checkFromHost(host)
    if (check !== undefined) return check
  }
  return localApiKeyCheck
}

/** The bound predicate, computed once: probing a package cannot change mid-process. */
let boundCheck: Promise<ApiKeyCheck> | undefined

/**
 * The credential predicate for the running harness.
 *
 * The dynamic import is deliberately allowed to fail: a host that never shipped
 * `@deepseek-ai/dsh-credentials` must still load this plugin, and so must a host
 * whose module resolution refuses the package. The resulting binding is cached,
 * failures included, so the probe costs one import at most once per process.
 * @returns the predicate this process will use for every key.
 */
export function apiKeyCheck(): Promise<ApiKeyCheck> {
  boundCheck ??= bindApiKeyCheck()
  return boundCheck
}

/** Resolve the predicate once; see {@link apiKeyCheck}. */
async function bindApiKeyCheck(): Promise<ApiKeyCheck> {
  const fromLlm = checkFromHost(llm)
  if (fromLlm !== undefined) return fromLlm
  let credentials: unknown
  try {
    credentials = await import(CREDENTIALS_PACKAGE)
  } catch {
    credentials = undefined
  }
  return pickApiKeyCheck([credentials])
}

/**
 * Judge one credential with the running harness's own rule.
 * @param raw - the credential exactly as configured, stored, or typed.
 * @param pkg - the refusing package name, prefixed to the diagnostic.
 * @param ref - the credential reference the value resolved through.
 * @returns the trimmed, usable key.
 * @throws {LlmError} `INVALID_CREDENTIAL` when the key cannot be sent.
 */
export async function assertUsableApiKey(raw: string, pkg: string, ref: string): Promise<string> {
  return (await apiKeyCheck())(raw, pkg, ref)
}
