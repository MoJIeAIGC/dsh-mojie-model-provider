#!/usr/bin/env node
/**
 * Generate the format-1 plugin-market index for this package.
 *
 * DSH reads market indexes listed in `plugin-market.indexes` (the desktop profile
 * ships `https://dshmarket.com/index.json`). An index is one JSON document that
 * names a plugin, its display metadata, and one installable entry per version:
 * `{ source: { type: 'npm' } }` installs `name@version`, `{ type: 'git' }`
 * installs the commit-pinned `git+https` URL (optionally with `path:`).
 *
 * The document is validated with `@deepseek-ai/dsh-plugin-market-index`, the same
 * parser the DSH client uses, so a published index can never be one the client
 * rejects.
 *
 * Usage:
 *   node scripts/build-market-index.mjs                     # npm source, package version
 *   node scripts/build-market-index.mjs --source git --commit <40-hex>
 *   node scripts/build-market-index.mjs --out dist/index.json
 *
 * Environment:
 *   MARKET_INDEX_URL  absolute URL the file will be served from; used to resolve
 *                     relative icon references and printed as the URL users add.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const options = parseArgs(process.argv.slice(2))
const repositoryURL = normalizeRepository(pkg.repository?.url)
const ownerRepo = repositoryURL.replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '')
const indexURL = process.env.MARKET_INDEX_URL
  ?? `https://raw.githubusercontent.com/${ownerRepo}/main/market-index.json`
const outputPath = options.out === undefined
  ? join(ROOT, 'market-index.json')
  : isAbsolute(options.out) ? options.out : join(ROOT, options.out)

const source = options.source === 'git'
  ? { type: 'git', url: repositoryURL, commit: requireCommit(options.commit) }
  : { type: 'npm' }

const version = {
  version: pkg.version,
  publishTimestamp: reuseTimestamp(outputPath, pkg.version) ?? Math.floor(Date.now() / 1000),
  source,
  engines: { dsh: options.dsh ?? '>=0.2.1-rc.2 <0.3.0-0' },
}

const index = {
  format: 1,
  title: { en: 'Mojie for DeepSeek Harness', zh: 'Mojie 模型插件（DSH）' },
  description: {
    en: 'Mojie (mojieaigc.com) models as a DSH provider route, plus native image generation.',
    zh: '把 Mojie（mojieaigc.com）的模型接入 DSH，并提供原生图片生成与编辑。',
  },
  metadata: {
    categories: {
      model: { title: { en: 'Models & Providers', zh: '模型接入' } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [{
    name: pkg.name,
    title: { en: 'Mojie Model Provider', zh: 'Mojie 模型插件' },
    description: {
      en: 'GPT/Claude/Gemini/Qwen/DeepSeek/Doubao/Kimi/Grok/GLM models through one Mojie key, with /image and native image tools.',
      zh: '用一个 Mojie Key 接入 GPT/Claude/Gemini/Qwen/DeepSeek/豆包/Kimi/Grok/GLM，并自带 /image 与原生画图工具。',
    },
    author: 'MoJIeAIGC',
    // Relative to this index URL, which the client resolves for the market row.
    icon: 'docs/assets/mojie-logo.png',
    homepage: repositoryURL,
    repository: { url: repositoryURL },
    metadata: {
      category: 'model',
      keywords: ['dsh-plugin', 'mojie', 'model-provider', 'image-generation'],
      labels: [],
      sortKeys: {},
    },
    versions: [version],
  }],
}

// Validate exactly as the DSH client will; a rejected index fails here instead.
const validated = parseMarketIndex(index, indexURL)
const target = marketInstallTarget(validated.plugins[0].name, validated.plugins[0].versions[0])

writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${outputPath}`)
console.log(`plugin:   ${validated.plugins[0].name}@${version.version}`)
console.log(`install:  ${target.spec}`)
console.log(`index url to add in Settings → Plugins → market: ${indexURL}`)

// ---------------------------------------------------------------------------

/** Parse the small flag set this script accepts. */
function parseArgs(argv) {
  const result = { source: 'npm' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    if (token === '--source') {
      if (value !== 'npm' && value !== 'git') fail('--source must be npm or git')
      result.source = value
      index += 1
    } else if (token === '--commit') {
      result.commit = value
      index += 1
    } else if (token === '--out') {
      result.out = value
      index += 1
    } else if (token === '--dsh') {
      result.dsh = value
      index += 1
    } else if (token === '--help' || token === '-h') {
      console.log('usage: build-market-index.mjs [--source npm|git] [--commit <sha>] [--out <path>] [--dsh <range>]')
      process.exit(0)
    } else {
      fail(`unknown argument: ${token}`)
    }
  }
  return result
}

/** Normalize the package repository URL into an absolute https web URL. */
function normalizeRepository(raw) {
  if (typeof raw !== 'string' || raw.length === 0) fail('package.json repository.url is required')
  const https = raw.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://')
  if (!/^https:\/\/github\.com\//u.test(https)) fail(`expected a github repository URL, got ${raw}`)
  return https.replace(/\.git$/u, '').replace(/\/+$/u, '')
}

/** A git-sourced version must pin an exact lowercase commit. */
function requireCommit(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    fail('--source git needs --commit <40-hex commit sha>')
  }
  return commit
}

/** Keep the publish time stable when regenerating the same version. */
function reuseTimestamp(path, version) {
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8'))
    const entry = previous?.plugins?.[0]?.versions?.[0]
    return entry?.version === version && Number.isInteger(entry.publishTimestamp)
      ? entry.publishTimestamp
      : undefined
  } catch {
    return undefined
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
