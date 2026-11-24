#!/usr/bin/env node
/**
 * Verify this plugin's built lib only imports host symbols the target harness
 * actually provides.
 *
 * A missing *named* export is an ESM link error: the entry fails before any of
 * its code runs, so it cannot be caught, degraded, or explained by the plugin
 * itself — the loader only reports "1 entry did not activate". That is what
 * happened in 0.3.0 when `@deepseek-ai/dsh-llm` dropped `assertUsableApiKey` in
 * the 0.2.3-alpha line. Checking the import surface against a candidate runtime
 * is cheap; discovering it from a user's screenshot is not.
 *
 * Usage:
 *   node scripts/check-host-exports.mjs                  # against this repo's node_modules
 *   node scripts/check-host-exports.mjs --host <dir>     # <dir> contains @deepseek-ai/<pkg>
 *
 * Only required peer dependencies are checked: those are the packages the host
 * supplies, while ordinary dependencies ship inside this plugin.
 *
 * Exit code 1 lists every missing symbol; 0 means the lib can link.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const host = option('--host') ?? join(ROOT, 'node_modules')
const required = Object.keys(pkg.peerDependencies ?? {})
  .filter((name) => pkg.peerDependenciesMeta?.[name]?.optional !== true)

/** Read one `--name value` pair from argv. */
function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Every `.js` file under the built lib, in a stable order. */
function jsFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return jsFiles(path)
    return path.endsWith('.js') ? [path] : []
  })
}

/**
 * Named (and default) bindings one import statement takes from a package.
 * Scoped to static imports, which are the ones ESM links before execution.
 */
function bindingsOf(statement) {
  if (/^import\s+type\b/u.test(statement)) return []
  const named = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}/su.exec(statement)
  if (named !== null) {
    return [...named[1].matchAll(/(?:type\s+)?([\w$]+)(?:\s+as\s+[\w$]+)?/gu)]
      .filter((match) => !/^\s*type\s/u.test(match[0]))
      .map((match) => match[1])
  }
  const direct = /import\s+(?:type\s+)?([\w$]+)\s*(?:,|from)/u.exec(statement)
  return direct === null ? [] : ['default']
}

/** Names a bundled ESM module exports, read from its own `export { … }` list. */
function exportsOf(file) {
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/gu)) {
    for (const item of block[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/u)
      const exported = (parts[1] ?? parts[0])?.trim()
      if (exported !== undefined && exported !== '') names.add(exported)
    }
  }
  for (const direct of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gu)) {
    names.add(direct[1])
  }
  if (/export\s+default\b/u.test(source)) names.add('default')
  return names
}

/** Runtime entry file of one host package, from its exports map or `main`. */
function entryOf(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const exported = manifest.exports?.['.']
  const target = typeof exported === 'string'
    ? exported
    : exported?.default ?? exported?.import ?? manifest.module ?? manifest.main
  if (typeof target !== 'string') throw new Error(`${manifest.name}: no ESM entry to inspect`)
  return join(directory, target)
}

let failed = false
const built = jsFiles(join(ROOT, 'lib'))
if (built.length === 0) {
  console.log('✗ lib/ is empty: run `npm run build` first')
  process.exit(1)
}
for (const name of required) {
  const directory = join(host, name)
  let provided
  try {
    provided = exportsOf(entryOf(directory))
  } catch (cause) {
    console.log(`? ${name}: cannot inspect at ${relative(ROOT, directory)} (${cause.message})`)
    continue
  }
  const wanted = new Set()
  for (const file of jsFiles(join(ROOT, 'lib'))) {
    for (const statement of readFileSync(file, 'utf8')
      .matchAll(new RegExp(String.raw`import\s+[^;]*?\sfrom\s*'${name.replaceAll('/', String.raw`\/`)}'`, 'gu'))) {
      for (const binding of bindingsOf(statement[0])) wanted.add(binding)
    }
  }
  const missing = [...wanted].filter((binding) => !provided.has(binding)).sort()
  if (missing.length === 0) {
    console.log(`ok ${name}: ${wanted.size} imported bindings all exported`)
  } else {
    failed = true
    console.log(`✗ ${name}: missing ${missing.join(', ')}`)
  }
}

if (failed) {
  console.log('\nThe built lib cannot link against this host. Use a supported harness or stop importing the symbol.')
  process.exitCode = 1
}
