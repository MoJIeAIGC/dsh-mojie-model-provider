/**
 * Bundle the browser half into the DSH client-module factory format.
 *
 * The official client packages build through the monorepo's tsdown preset. This
 * standalone repository only needs one dependency (`react`), so esbuild plus the
 * documented `window.__ModuleLoader__.load({...})` wrapper is enough.
 *
 * The package version is compiled in as `__MOJIE_VERSION__` so the update
 * reminder compares against the version this bundle was built from, without
 * reading `package.json` from the page.
 */

import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const ID = '@mojieai/dsh-mojie-model-provider'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/client/index.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  define: {
    __MOJIE_VERSION__: JSON.stringify(manifest.version),
  },
  banner: {
    js: `window.__ModuleLoader__.load({\n`
      + `  id: ${JSON.stringify(ID)},\n`
      + '  factory: (require) => {\n'
      + '    var module = { exports: {} };\n'
      + '    var exports = module.exports;',
  },
  footer: {
    js: '    return module.exports;\n  }\n});\n',
  },
  logLevel: 'info',
})
