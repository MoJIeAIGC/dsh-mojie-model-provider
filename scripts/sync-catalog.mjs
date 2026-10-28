/**
 * Regenerate the built-in Mojie model catalog from the live `/v1/models` listing.
 *
 * The site adds and retires models without warning, so the plugin never hand-maintains
 * this list: `src/catalog.generated.ts` and `tests/fixtures/mojie-models.json` are both
 * machine-written from one fetch. Built-in metadata only fills the gap before live
 * discovery answers; discovery still wins whenever it discloses more.
 *
 * Usage:
 *   node scripts/sync-catalog.mjs            # rewrite the catalog + fixture
 *   node scripts/sync-catalog.mjs --check    # fail when the committed snapshot drifted
 *
 * Environment:
 *   MOJIE_BASE_URL  site root to interrogate (default `https://mojieaigc.com`)
 *   MOJIE_API_KEY   bearer key; optional because the public listing answers without one
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED_FILE = join(ROOT, 'src', 'catalog.generated.ts')
const FIXTURE_FILE = join(ROOT, 'tests', 'fixtures', 'mojie-models.json')

const MODALITIES = new Set(['text', 'image'])
const LINE_WIDTH = 120

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

/** Fetch the live listing, then rewrite the snapshot or verify the committed one. */
async function main() {
  const checkMode = process.argv.includes('--check')
  const baseURL = normalizeBaseURL(process.env.MOJIE_BASE_URL ?? 'https://mojieaigc.com')
  const apiKey = process.env.MOJIE_API_KEY ?? storedCredential('MOJIE_API_KEY')
  const models = await fetchListing(baseURL, apiKey)
  const fetchedAt = new Date().toISOString()
  const previous = readPreviousFixture()
  reportDiff(previous, models)

  if (checkMode) {
    if (previous === undefined) fail(`no committed snapshot at ${relative(FIXTURE_FILE)}; run without --check first`)
    const drift = describeDiff(previous, models)
    if (drift.length > 0) fail(`model catalog drifted from ${baseURL}/v1/models:\n  ${drift.join('\n  ')}`)
    console.log(`catalog snapshot matches ${baseURL}/v1/models (${models.length} models)`)
    return
  }

  mkdirSync(dirname(FIXTURE_FILE), { recursive: true })
  writeFileSync(FIXTURE_FILE, `${JSON.stringify({ baseURL: baseURL, endpoint: `${baseURL}/v1/models`, fetchedAt, models }, null, 2)}\n`, 'utf8')
  writeFileSync(GENERATED_FILE, renderModule(baseURL, fetchedAt, models), 'utf8')
  console.log(`wrote ${relative(FIXTURE_FILE)} and ${relative(GENERATED_FILE)} (${models.length} models)`)
}

// ---------------------------------------------------------------------------

/** Trim a configured site root to its origin. */
function normalizeBaseURL(raw) {
  const parsed = new URL(raw)
  const path = parsed.pathname.replace(/\/+$/, '')
  return path === '' || path === '/v1' ? parsed.origin : `${parsed.origin}${path}`
}

/** Read one reference out of the DSH credential store, so local runs need no exported key. */
function storedCredential(ref) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  let raw
  try {
    raw = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const line = raw.split(/\r?\n/).find((entry) => new RegExp(`^\\s+${ref}\\s*:`).test(entry))
  const value = line?.split(/:\s*/, 2)[1]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

/** Fetch and normalize Mojie's public model listing. */
async function fetchListing(root, key) {
  const endpoint = `${root}/v1/models`
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
    },
  })
  if (!response.ok) fail(`${endpoint} answered ${response.status}`)
  const body = JSON.parse(await response.text())
  if (!Array.isArray(body?.data)) fail(`${endpoint} returned no data array`)
  const seen = new Set()
  const result = []
  for (const row of body.data) {
    const model = normalizeRow(row)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  if (result.length === 0) fail(`${endpoint} listed no models`)
  return result
}

/**
 * Normalize one listing row exactly like `readListing` in src/discovery.ts: ids and
 * names as reported, capacity only when disclosed, and modalities narrowed to the two
 * DSH can actually send.
 */
function normalizeRow(row) {
  if (typeof row !== 'object' || row === null) return undefined
  const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined
  if (id === undefined) return undefined
  const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : id
  const contextWindow = positiveInteger(row.context_length) ?? positiveInteger(row.context_window)
  const maxTokens = positiveInteger(row.max_output_tokens)
  const modalities = Array.isArray(row.input_modalities)
    ? [...new Set(row.input_modalities.filter((entry) => MODALITIES.has(entry)))]
    : []
  return {
    id,
    name,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...modalities.length === 0 ? {} : { inputModalities: modalities },
  }
}

function positiveInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/** Snapshot committed by the previous sync, used only to print a human diff. */
function readPreviousFixture() {
  try {
    const parsed = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
    return Array.isArray(parsed?.models) ? parsed.models : undefined
  } catch {
    return undefined
  }
}

function describeDiff(previous, next) {
  if (previous === undefined) return [`no previous snapshot; ${next.length} models listed`]
  const before = new Map(previous.map((model) => [model.id, model]))
  const after = new Map(next.map((model) => [model.id, model]))
  const lines = []
  for (const id of after.keys()) if (!before.has(id)) lines.push(`+ ${id}`)
  for (const id of before.keys()) if (!after.has(id)) lines.push(`- ${id}`)
  for (const [id, model] of after) {
    const old = before.get(id)
    if (old !== undefined && JSON.stringify(old) !== JSON.stringify(model)) lines.push(`~ ${id}`)
  }
  return lines
}

function reportDiff(previous, next) {
  const drift = describeDiff(previous, next)
  if (drift.length === 0) {
    console.log(`no catalog change (${next.length} models)`)
    return
  }
  console.log(drift.join('\n'))
}

/** Render `src/catalog.generated.ts` with one deterministic, reviewable row per model. */
function renderModule(root, stamp, catalog) {
  const rows = catalog.map(renderRow).join('\n')
  return `/**
 * Mojie model catalog snapshot — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source: \`GET ${root}/v1/models\`
 * Fetched: ${stamp}
 * Models: ${catalog.length}
 *
 * Refresh with \`pnpm sync:catalog\` (scripts/sync-catalog.mjs). This snapshot keeps the
 * first request of a session correct before live discovery answers; the live listing
 * still overrides it wherever it discloses more.
 */

import type { MojieCatalogModel } from './catalog.js'

/** Built-in catalog rows in \`/v1/models\` order. */
export const BUILTIN_CATALOG_MODELS: readonly MojieCatalogModel[] = [
${rows}
]
`
}

function renderRow(model) {
  const fields = [
    `id: ${quote(model.id)}`,
    `name: ${quote(model.name)}`,
    ...model.contextWindow === undefined ? [] : [`contextWindow: ${number(model.contextWindow)}`],
    ...model.maxTokens === undefined ? [] : [`maxTokens: ${number(model.maxTokens)}`],
    ...model.inputModalities === undefined
      ? []
      : [`inputModalities: [${model.inputModalities.map(quote).join(', ')}]`],
  ]
  const single = `  { ${fields.join(', ')} },`
  if (single.length <= LINE_WIDTH) return single
  return `  {\n${fields.map((field) => `    ${field},`).join('\n')}\n  },`
}

function quote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function number(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

function relative(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1).split('\\').join('/') : path
}

function fail(message) {
  throw new Error(message)
}
