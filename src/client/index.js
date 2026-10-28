/**
 * Mojie provider card for the Models settings page.
 *
 * The core Models page only ships curated editors for the first-party adapter
 * families. This browser half registers the `settings.models.provider-card`
 * seat under the Mojie settings namespace and edits the same volatile Config
 * fields the Host reads per request. The API key never enters a settings
 * section: it is written through the credentials domain under the `apiKeyEnv`
 * reference, exactly as the Models page stores any other provider key.
 */

import { createElement as h, useEffect, useState } from 'react'

/** Settings namespace: the profile entry id pinned by the bundle patch. */
const NS = 'mojie'
/** Conventional credential reference used when the profile names none. */
const DEFAULT_REF = 'MOJIE_API_KEY'

/** Cordis services this browser plugin needs before it applies. */
export const inject = ['slots', 'configForms', 'remote', 'remote.credentials', 'remote.llm']

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }
const labelStyle = { fontSize: 12, opacity: 0.8 }
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '1px solid var(--vscode-input-border, #555)',
  borderRadius: 4,
  background: 'var(--vscode-input-background, transparent)',
  color: 'inherit',
  font: 'inherit',
}
const cardStyle = {
  marginTop: 12,
  padding: 12,
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 6,
}
const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }
const hintStyle = { fontSize: 12, opacity: 0.75, margin: '4px 0 0' }
const errorStyle = { fontSize: 12, color: 'var(--vscode-errorForeground, #f66)', margin: '6px 0 0' }

/**
 * Observe one shared settings form without pulling in the settings primitives.
 * @param {object} form - `ctx.configForms` controller for the Mojie namespace.
 * @returns {object} the current form snapshot.
 */
function useFormSnapshot(form) {
  const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
  useEffect(() => {
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
  }, [form])
  return snapshot
}

/** Render one model array as pretty JSON without the empty capability arrays Schemastery materializes. */
function formatModels(models) {
  const cleaned = Array.isArray(models)
    ? models.map((model) => {
      const copy = { ...model }
      if (Array.isArray(copy.inputModalities) && copy.inputModalities.length === 0) delete copy.inputModalities
      if (Array.isArray(copy.reasoningEfforts) && copy.reasoningEfforts.length === 0) delete copy.reasoningEfforts
      return copy
    })
    : []
  return JSON.stringify(cleaned, null, 2)
}

/** Parse the models textarea; an empty field means "use discovery". */
function parseModels(text) {
  if (text.trim() === '') return []
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('models 必须是 JSON 数组。')
  return parsed
}

/** Validate an optional endpoint before writing it. */
function validateBaseURL(value) {
  if (value === '') return
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Base URL 必须是绝对的 http(s) URL。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 必须使用 http 或 https。')
  }
}

/**
 * Union of the discovered image models and the currently configured one, so a
 * hand-written or retired id still renders as the selected option.
 * @param {string[]} discovered - model ids from `/v1/media/models`.
 * @param {string} current - configured `imageDefaultModel`.
 * @returns {string[]} option ids in display order.
 */
function imageOptionValues(discovered, current) {
  const values = []
  for (const id of [...discovered, current]) {
    if (typeof id === 'string' && id.length > 0 && !values.includes(id)) values.push(id)
  }
  return values
}

/**
 * Render the Mojie provider card.
 * @param {object} props - slot owner props plus the injected `mojie` face.
 * @returns {object} the card element.
 */
function MojieProviderCard(props) {
  const form = props.mojie.form
  const snapshot = useFormSnapshot(form)
  const value = snapshot.value ?? {}
  const [apiKeyEnv, setApiKeyEnv] = useState(() => value.apiKeyEnv ?? DEFAULT_REF)
  const [baseURL, setBaseURL] = useState(() => value.baseURL ?? '')
  const [modelsText, setModelsText] = useState(() => formatModels(value.models))
  const [imageModel, setImageModel] = useState(() => value.imageDefaultModel ?? '')
  const [imageModels, setImageModels] = useState([])
  const [imageLoading, setImageLoading] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState(undefined)

  useEffect(() => {
    if (dirty || snapshot.status !== 'ready') return
    const current = snapshot.value ?? {}
    setApiKeyEnv(current.apiKeyEnv ?? DEFAULT_REF)
    setBaseURL(current.baseURL ?? '')
    setModelsText(formatModels(current.models))
    setImageModel(current.imageDefaultModel ?? '')
  }, [snapshot.revision, snapshot.status, dirty])

  /**
   * Load the image-model list for the dropdown through the provider's own model
   * discovery, tagged so the Host answers with `/v1/media/models`.
   * @param {boolean} report - whether to surface the outcome in the status line.
   */
  const loadImageModels = async (report) => {
    setImageLoading(true)
    if (report) setStatus(undefined)
    try {
      const base = baseURL.trim()
      validateBaseURL(base)
      const response = await props.mojie.ctx.remote.llm.discoverModels(NS, {
        provider: NS,
        api: 'mojie-media-models',
        ...(base === '' ? {} : { baseURL: base }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      })
      if (!response.ok) throw new Error(response.error?.message ?? '获取图片模型失败。')
      const discovered = Array.isArray(response.value) ? response.value : []
      const ids = discovered
        .map((model) => model?.id)
        .filter((id) => typeof id === 'string' && id.length > 0)
      setImageModels(ids)
      if (report) setStatus(`已获取 ${ids.length} 个图片模型。`)
    } catch (error) {
      if (report) setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setImageLoading(false)
    }
  }

  useEffect(() => {
    // Best-effort warm-up: a missing key or an offline gateway must not block the
    // rest of the card, so this load never reports into the status line.
    if (snapshot.status !== 'ready') return
    void loadImageModels(false)
  }, [snapshot.status])

  if (snapshot.status === 'loading') {
    return h('p', { style: hintStyle }, 'Mojie 设置加载中…')
  }
  if (snapshot.status === 'unavailable') {
    return h('p', { style: hintStyle }, '当前 Host 没有提供 Mojie 设置。')
  }
  if (!snapshot.writable) {
    return h('p', { style: hintStyle }, 'Mojie 设置当前为只读。')
  }

  const edit = (setter, next) => {
    setter(next)
    setDirty(true)
    setStatus(undefined)
  }

  const reset = () => {
    const current = snapshot.value ?? {}
    setApiKeyEnv(current.apiKeyEnv ?? DEFAULT_REF)
    setBaseURL(current.baseURL ?? '')
    setModelsText(formatModels(current.models))
    setImageModel(current.imageDefaultModel ?? '')
    setApiKey('')
    setDirty(false)
    setStatus(undefined)
  }

  const save = async () => {
    setBusy(true)
    setStatus(undefined)
    try {
      const models = parseModels(modelsText)
      const ref = apiKeyEnv.trim() || DEFAULT_REF
      const base = baseURL.trim()
      validateBaseURL(base)
      // Always record the reference: the Models page and the Host's provider
      // readiness check join the stored credential through this field.
      if (!await form.set('apiKeyEnv', ref)) throw new Error('Host 拒绝写入 apiKeyEnv。')
      if (base === '') {
        if (!await form.unset('baseURL')) throw new Error('Host 拒绝清除 baseURL。')
      } else if (!await form.set('baseURL', base)) {
        throw new Error('Host 拒绝写入 baseURL。')
      }
      if (models.length === 0) {
        if (!await form.unset('models')) throw new Error('Host 拒绝清除 models。')
      } else if (!await form.set('models', models)) {
        throw new Error('Host 拒绝写入 models。')
      }
      const chosenImageModel = imageModel.trim()
      if (chosenImageModel === '') {
        if (!await form.unset('imageDefaultModel')) throw new Error('Host 拒绝清除 imageDefaultModel。')
      } else if (!await form.set('imageDefaultModel', chosenImageModel)) {
        throw new Error('Host 拒绝写入 imageDefaultModel。')
      }
      if (apiKey.trim().length > 0) {
        const stored = await props.mojie.ctx.remote.credentials.set(ref, apiKey.trim())
        if (!stored.ok) throw new Error(stored.error?.message ?? 'Host 拒绝保存凭据。')
        setApiKey('')
      }
      setDirty(false)
      setStatus('已保存。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    setStatus(undefined)
    try {
      const base = baseURL.trim()
      validateBaseURL(base)
      const request = {
        provider: NS,
        ...(base === '' ? {} : { baseURL: base }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      }
      const response = await props.mojie.ctx.remote.llm.discoverModels(NS, request)
      if (!response.ok) throw new Error(response.error?.message ?? '获取模型失败。')
      const discovered = Array.isArray(response.value) ? response.value : []
      const current = parseModels(modelsText)
      const byId = new Map()
      for (const model of current) {
        if (typeof model?.id === 'string' && model.id.length > 0) byId.set(model.id, model)
      }
      let added = 0
      for (const model of discovered) {
        if (typeof model?.id !== 'string' || model.id.length === 0 || byId.has(model.id)) continue
        byId.set(model.id, {
          id: model.id,
          ...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {}),
        })
        added += 1
      }
      if (added > 0) {
        setModelsText(formatModels([...byId.values()]))
        setDirty(true)
        setStatus(`已获取 ${discovered.length} 个模型，新增 ${added} 个，点击保存生效。`)
      } else {
        setStatus(`已获取 ${discovered.length} 个模型，当前列表已包含全部。`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  const statusStyle = status !== undefined && (status.startsWith('已保存') || status.startsWith('已获取'))
    ? hintStyle
    : errorStyle

  return h('div', { style: cardStyle }, [
    h('strong', { key: 'title' }, 'Mojie provider 设置'),
    h('p', { key: 'credential', style: hintStyle },
      props.keyConfigured ? '已配置凭据。' : '尚未配置凭据。'),
    h('label', { key: 'ref', style: fieldStyle }, [
      h('span', { key: 'label', style: labelStyle }, '凭据引用（环境变量 / credentials）'),
      h('input', {
        key: 'input',
        style: inputStyle,
        value: apiKeyEnv,
        placeholder: DEFAULT_REF,
        onChange: event => edit(setApiKeyEnv, event.target.value),
      }),
    ]),
    h('label', { key: 'key', style: fieldStyle }, [
      h('span', { key: 'label', style: labelStyle }, 'API Key（留空则保留已存密钥）'),
      h('input', {
        key: 'input',
        style: inputStyle,
        type: 'password',
        value: apiKey,
        placeholder: props.keyConfigured ? '输入新密钥以替换' : '粘贴 Mojie API Key',
        onChange: event => edit(setApiKey, event.target.value),
      }),
    ]),
    h('label', { key: 'base', style: fieldStyle }, [
      h('span', { key: 'label', style: labelStyle }, 'Base URL'),
      h('input', {
        key: 'input',
        style: inputStyle,
        value: baseURL,
        placeholder: 'https://mojieaigc.com',
        onChange: event => edit(setBaseURL, event.target.value),
      }),
    ]),
    h('label', { key: 'models', style: fieldStyle }, [
      h('span', { key: 'label', style: labelStyle }, '模型列表（JSON 数组；留空使用 /v1/models 发现）'),
      h('textarea', {
        key: 'input',
        style: { ...inputStyle, minHeight: 120, fontFamily: 'monospace' },
        value: modelsText,
        spellCheck: false,
        onChange: event => edit(setModelsText, event.target.value),
      }),
    ]),
    h('label', { key: 'image-model', style: fieldStyle }, [
      h('span', { key: 'label', style: labelStyle }, '图片生成默认模型（/image 与 mojie_generate_image 共用）'),
      h('div', { key: 'row', style: { ...rowStyle, marginTop: 4 } }, [
        h('select', {
          key: 'select',
          style: { ...inputStyle, flex: '1 1 220px', minWidth: 200 },
          value: imageOptionValues(imageModels, imageModel).includes(imageModel) ? imageModel : '',
          disabled: busy || imageLoading,
          onChange: event => edit(setImageModel, event.target.value),
        }, [
          h('option', { key: 'placeholder', value: '' }, '（使用部署默认）'),
          ...imageOptionValues(imageModels, imageModel).map(id => h('option', { key: id, value: id }, id)),
        ]),
        h('button', {
          key: 'load-image',
          type: 'button',
          disabled: busy || imageLoading,
          onClick: () => { void loadImageModels(true) },
        }, imageLoading ? '获取中…' : '刷新图片模型'),
      ]),
      h('p', { key: 'hint', style: hintStyle },
        '已选：' + (imageModel === '' ? '部署默认' : imageModel) + '。保存后生效；也可以直接在对话里 /image model <id> 切换。'),
      imageModels.length === 0
        ? h('p', { key: 'empty', style: errorStyle }, '还没有取到图片模型列表，点「刷新图片模型」获取。')
        : null,
    ]),
    h('div', { key: 'actions', style: rowStyle }, [
      h('button', {
        key: 'refresh',
        type: 'button',
        disabled: busy || refreshing,
        onClick: () => { void refresh() },
      }, refreshing ? '获取中…' : '刷新模型列表'),
      h('button', {
        key: 'save',
        type: 'button',
        disabled: busy || refreshing || !dirty,
        onClick: () => { void save() },
      }, busy ? '保存中…' : '保存 Mojie 设置'),
      h('button', {
        key: 'reset',
        type: 'button',
        disabled: busy || refreshing || !dirty,
        onClick: reset,
      }, '重置'),
    ]),
    status === undefined
      ? null
      : h('p', { key: 'status', style: statusStyle }, status),
  ])
}

/**
 * Register the Mojie card under the Models page's keyed provider-card seat.
 * @param {object} ctx - the browser plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.configForms.whileServed([NS], () => {
      const face = { form: ctx.configForms.get(NS), ctx }
      return ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
        inject: () => ({ mojie: face }),
      }, MojieProviderCard))
    }),
    'mojie: Models provider card',
  )
}
