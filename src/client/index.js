/**
 * Mojie provider card for the Models settings page.
 *
 * The page renders this card inside the Mojie provider row through the keyed
 * `settings.models.provider-card` seat. It follows the layout of the page's own
 * “自定义模型 API” editor — API key, collapsible advanced fields, the model
 * catalog with its fetch dialog, expandable model rows, and a cancel/save
 * footer — because that is the shape users already know from a hand-declared
 * provider.
 *
 * The card auto-fills what it can: the model catalog comes from the shipped
 * snapshot before discovery answers and from `/v1/models` afterwards, every row
 * carries the disclosed context window / output cap / input types, and each
 * model's thinking levels are the vendor recommendation the adapter publishes.
 * The API key is still write-only and travels through the credentials service,
 * exactly as the page stores any other provider key.
 *
 * @module @mojieai/dsh-mojie-model-provider/client
 */

import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  autoReasoning,
  catalogCandidates,
  declaredEfforts,
  EFFORT_LEVELS,
  effectiveCapacity,
  effectiveModalities,
  effectiveReasoning,
  formatCapacity,
  inheritedRows,
  mergePickedModels,
  modelConfigFromRow,
  parseCapacity,
  reasoningMode,
} from './catalog-data.js'
import {
  Checkbox,
  Chip,
  ChevronIcon,
  cls,
  Dialog,
  ensureStyles,
  EyeIcon,
  Field,
  IconButton,
  LinkButton,
  PlusIcon,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
  TrashIcon,
} from './native-ui.js'
import { registerMojieToolViews } from './toolview.js'
import { sortModelOrder } from '../order.ts'

/** Settings namespace: the profile entry id pinned by the bundle patch. */
const NS = 'mojie'
/** Conventional credential reference used when the profile names none. */
const DEFAULT_REF = 'MOJIE_API_KEY'
/** Endpoint the provider ships with; the field starts from this value. */
const DEFAULT_BASE_URL = 'https://mojieaigc.com'
/** Host marker that answers this discovery with `/v1/media/models`. */
const MEDIA_DISCOVERY_API = 'mojie-media-models'

/** Cordis services this browser plugin needs before it applies. */
export const inject = ['slots', 'configForms', 'remote', 'remote.credentials', 'remote.llm']

/** Vendor family labels used by the auto-filled thinking hint. */
const VENDOR_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  zhipu: '智谱',
  alibaba: '阿里',
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  bytedance: '豆包',
  generic: '通用',
}

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

/**
 * Turn stored model rows into editable drafts, keeping the stored row so a save
 * never drops a hand-written field this card does not show.
 * @param {object} value - settings value.
 * @returns {object[]} draft rows.
 */
function rowsFromValue(value) {
  const list = Array.isArray(value?.models) ? value.models : []
  return sortModelOrder(list.flatMap((model) => {
    if (typeof model !== 'object' || model === null || typeof model.id !== 'string') return []
    // Schemastery materializes an absent capability array as `[]`. An empty
    // list declares nothing, so keep it out of the draft and out of the next
    // write instead of mistaking it for a custom (empty) ladder.
    const cleaned = { ...model }
    for (const key of ['inputModalities', 'reasoningEfforts']) {
      if (Array.isArray(cleaned[key]) && cleaned[key].length === 0) delete cleaned[key]
    }
    return [{ ...cleaned, _original: { ...cleaned }, _capacity: {} }]
  }))
}

/**
 * Apply a patch, treating `undefined` as "remove this field" so the stored JSON
 * never keeps a null that the host validator would reject.
 * @param {object} row - draft row.
 * @param {object} patch - fields to write.
 * @returns {object} the patched row.
 */
function patchRow(row, patch) {
  const next = { ...row }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Validate an optional endpoint before writing it. */
function validateBaseURL(value) {
  if (value === '') return
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址。')
  }
}

/**
 * Mirror the host's key rule: a typed key is printable ASCII only.
 * @param {string} draft - the key field.
 * @returns {string|undefined} an error message, or undefined when usable.
 */
function apiKeyFailure(draft) {
  if (draft.length === 0) return undefined
  const value = draft.trim()
  if (value.length === 0) return '请输入 API 密钥；留空则保持已存储的密钥。'
  if (!/^[\x21-\x7E]+$/u.test(value)) return '该 API 密钥格式错误，请检查。'
  return undefined
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
 * Field-level problems with the drafted model list.
 *
 * An absent or empty ladder means “auto”: the adapter applies the vendor
 * recommendation, so it is not a failure. Only a declared ladder can be wrong
 * (duplicates, or a default that is not one of its rungs).
 * @param {object[]} rows - draft rows.
 * @returns {{ rowErrors: Map<string, string>, duplicateIds: Set<string> }} the problems.
 */
export function validateRows(rows) {
  const rowErrors = new Map()
  const counts = new Map()
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id.length > 0) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const duplicateIds = new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id))
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id.length === 0) {
      rowErrors.set(row.id ?? '', '模型 ID 不能为空。')
      continue
    }
    if (duplicateIds.has(id)) {
      rowErrors.set(id, '模型 ID 不能重复。')
      continue
    }
    const capacity = row._capacity ?? {}
    const capacityText = (field) => capacity[field]
    if (typeof capacityText('contextWindow') === 'string' && Number.isNaN(parseCapacity(capacityText('contextWindow')))) {
      rowErrors.set(id, '容量需为数字，可加 K 或 M 后缀。')
      continue
    }
    if (typeof capacityText('maxTokens') === 'string' && Number.isNaN(parseCapacity(capacityText('maxTokens')))) {
      rowErrors.set(id, '容量需为数字，可加 K 或 M 后缀。')
      continue
    }
    if (row.reasoning === 'off') continue
    const efforts = declaredEfforts(row)
    if (efforts === undefined) continue
    if (new Set(efforts).size !== efforts.length) {
      rowErrors.set(id, '推理档位不能重复。')
      continue
    }
    if (row.defaultReasoningEffort !== undefined && !efforts.includes(row.defaultReasoningEffort)) {
      rowErrors.set(id, '默认档位必须在档位列表中。')
    }
  }
  return { rowErrors, duplicateIds }
}

/**
 * Render one model row: id and display name on the line, the auto-filled
 * metadata in the expanded area.
 *
 * Exported for the card's render tests, which cannot click a row open.
 * @param {object} props - row, metadata, position, handlers, and errors.
 * @returns {object} the row element.
 */
export function ModelRow(props) {
  const {
    row, meta, position, expanded, disabled, error, contextWindowText, maxTokensText,
    onToggle, onField, onCapacity, onModalities, onReasoningMode, onReasoningLevel,
    onAddLevel, onRemoveLevel, onDefaultLevel, onRemove,
  } = props
  const mode = reasoningMode(row)
  const ladder = effectiveReasoning(row)
  const modalities = effectiveModalities(row, meta)
  const levels = declaredEfforts(row) ?? []
  const vendor = VENDOR_LABELS[ladder?.vendor ?? ''] ?? ladder?.vendor ?? '厂商'
  const levelChoices = (current) => [
    ...EFFORT_LEVELS.includes(current) ? [] : [current],
    ...EFFORT_LEVELS.filter((choice) => choice === current || !levels.includes(choice)),
  ]
  return h('div', { className: cls.modelEntry }, [
    h('div', { key: 'row', className: cls.modelRow }, [
      h(TextInput, {
        key: 'id',
        className: cls.mono,
        value: typeof row.id === 'string' ? row.id : '',
        placeholder: '模型 ID',
        'aria-label': `模型 ID ${String(position)}`,
        disabled,
        onChange: (event) => onField('id', event.target.value),
      }),
      h(TextInput, {
        key: 'name',
        value: typeof row.name === 'string' ? row.name : '',
        placeholder: '显示名称（留空时使用模型 ID）',
        'aria-label': `显示名称 ${String(position)}`,
        disabled,
        onChange: (event) => onField('name', event.target.value === '' ? undefined : event.target.value),
      }),
      h(IconButton, {
        key: 'expand',
        'aria-label': `模型选项 ${String(position)}`,
        'aria-expanded': expanded,
        title: '模型选项',
        onClick: onToggle,
      }, h(ChevronIcon, { expanded })),
      h(IconButton, {
        key: 'remove',
        danger: true,
        'aria-label': `删除模型 ${String(position)}`,
        title: '删除模型',
        disabled,
        onClick: onRemove,
      }, h(TrashIcon)),
    ]),
    error === undefined ? null : h('p', { key: 'error', className: cls.error, role: 'alert' }, error),
    expanded ? h('div', { key: 'advanced', className: cls.modelAdvanced }, [
      h('label', { key: 'cw', className: cls.modelField }, [
        h('span', { key: 'label', className: cls.modelFieldLabel }, '上下文窗口'),
        h(TextInput, {
          key: 'input',
          value: contextWindowText,
          placeholder: '自动',
          inputMode: 'numeric',
          'aria-label': `上下文窗口 ${String(position)}`,
          disabled,
          onChange: (event) => onCapacity('contextWindow', event.target.value),
        }),
      ]),
      h('label', { key: 'mt', className: cls.modelField }, [
        h('span', { key: 'label', className: cls.modelFieldLabel }, '最大输出 token 数'),
        h(TextInput, {
          key: 'input',
          value: maxTokensText,
          placeholder: '自动',
          inputMode: 'numeric',
          'aria-label': `最大输出 token 数 ${String(position)}`,
          disabled,
          onChange: (event) => onCapacity('maxTokens', event.target.value),
        }),
      ]),
      h('fieldset', { key: 'modalities', className: cls.modelInputTypes, 'aria-label': `输入类型 ${String(position)}` }, [
        h('legend', { key: 'legend', className: cls.modelFieldLabel }, '输入类型'),
        h('div', { key: 'choices', className: cls.modelInputChoices }, ['text', 'image'].map((modality) => h(Checkbox, {
          key: modality,
          label: modality === 'text' ? '文本' : '图片',
          checked: modalities.includes(modality),
          disabled: disabled || modalities.length === 1 && modalities.includes(modality),
          onChange: (checked) => {
            const next = ['text', 'image'].filter((value) => value === modality ? checked : modalities.includes(value))
            onModalities(next.length === 0 ? ['text'] : next)
          },
        }))),
      ]),
      h('div', { key: 'reasoning', className: cls.modelReasoning, role: 'group', 'aria-label': `推理等级 ${String(position)}` }, [
        h('div', { key: 'head', className: cls.modelReasoningHead }, [
          h('span', { key: 'label', className: cls.modelFieldLabel }, '推理等级'),
          h(SelectInput, {
            key: 'mode',
            value: mode,
            'aria-label': `推理等级来源 ${String(position)}`,
            disabled,
            style: { maxWidth: 170 },
            onChange: (event) => onReasoningMode(event.target.value),
          }, [
            h('option', { key: 'auto', value: 'auto' }, '自动（厂商建议）'),
            h('option', { key: 'custom', value: 'custom' }, '自定义档位'),
            h('option', { key: 'off', value: 'off' }, '关闭思考'),
          ]),
        ]),
        mode === 'auto' ? h(Fragment, { key: 'auto' }, [
          ladder === undefined
            ? h('p', { key: 'none', className: cls.hint }, '该模型 ID 还没有档位建议。')
            : h('div', { key: 'chips', className: cls.efforts }, ladder.efforts.map((rung) => h(Chip, {
              key: rung.id,
              isDefault: rung.id === ladder.defaultEffort,
              title: rung.description,
            }, rung.id))),
          ladder === undefined ? null : h('p', { key: 'hint', className: cls.hint },
            `${vendor} 建议档位，默认 ${ladder.defaultEffort ?? '未指定'}；随请求发送 reasoning.effort。`),
        ]) : null,
        mode === 'off' ? h('p', { key: 'off', className: cls.hint }, '不发送 reasoning.effort；模型选择器不显示思考档位。') : null,
        mode === 'custom' ? h(Fragment, { key: 'custom' }, [
          h('p', { key: 'hint', className: cls.hint }, ladder?.source === 'declared'
            ? `${vendor} 档位已写入配置，可按需增删。`
            : `已自动填入 ${vendor} 建议档位，可继续增删。`),
          ...levels.map((level, index) => h('div', { key: `level-${String(index)}`, className: cls.modelReasoningRow }, [
            h(SelectInput, {
              key: 'level',
              value: level,
              'aria-label': `推理档位 ${String(index + 1)}`,
              disabled,
              onChange: (event) => onReasoningLevel(index, event.target.value),
            }, levelChoices(level).map((choice) => h('option', { key: choice, value: choice }, choice))),
            h(IconButton, {
              key: 'remove',
              danger: true,
              'aria-label': `删除档位 ${level}`,
              title: '删除档位',
              disabled,
              onClick: () => onRemoveLevel(index),
            }, h(TrashIcon)),
          ])),
          h(LinkButton, {
            key: 'add',
            disabled: disabled || EFFORT_LEVELS.every((choice) => levels.includes(choice)),
            onClick: onAddLevel,
          }, [h(PlusIcon, { key: 'icon' }), '添加档位']),
          h('label', { key: 'default', className: cls.modelField }, [
            h('span', { key: 'label', className: cls.modelFieldLabel }, '默认档位'),
            h(SelectInput, {
              key: 'input',
              value: typeof row.defaultReasoningEffort === 'string' ? row.defaultReasoningEffort : '',
              'aria-label': `默认档位 ${String(position)}`,
              disabled,
              onChange: (event) => onDefaultLevel(event.target.value === '' ? undefined : event.target.value),
            }, [
              h('option', { key: '', value: '' }, '自动（按厂商建议）'),
              ...levels.map((level) => h('option', { key: level, value: level }, level)),
            ]),
          ]),
        ]) : null,
      ]),
    ]) : null,
  ])
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
  const [baseURL, setBaseURL] = useState(() => value.baseURL ?? DEFAULT_BASE_URL)
  const [models, setModels] = useState(() => rowsFromValue(value))
  const [modelsMode, setModelsMode] = useState(() => (Array.isArray(value.models) && value.models.length > 0 ? 'custom' : 'inherit'))
  const [imageModel, setImageModel] = useState(() => value.imageDefaultModel ?? '')
  const [imageModels, setImageModels] = useState([])
  const [imageLoading, setImageLoading] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyRevealed, setKeyRevealed] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(() => props.keyConfigured !== true || (Array.isArray(value.models) && value.models.length > 0))
  const [expandedRows, setExpandedRows] = useState(() => new Set())
  const [discovered, setDiscovered] = useState(undefined)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState(undefined)
  const [fetchOpen, setFetchOpen] = useState(false)
  const [fetchQuery, setFetchQuery] = useState('')
  const [fetchFlips, setFetchFlips] = useState(() => new Set())
  const [fetchError, setFetchError] = useState(undefined)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(undefined)
  const autoLoadBase = useRef(undefined)

  // Auto-fill the catalog built into the bundle before any network answer.
  const autoRows = useMemo(() => inheritedRows(discovered), [discovered])
  const candidates = useMemo(() => catalogCandidates(discovered), [discovered])
  const metaById = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates])
  const displayRows = modelsMode === 'custom' ? models : autoRows
  const configuredIds = useMemo(
    () => new Set(displayRows.map((row) => (typeof row.id === 'string' ? row.id.trim() : '')).filter((id) => id.length > 0)),
    [displayRows],
  )

  useEffect(() => {
    if (dirty || snapshot.status !== 'ready') return
    const current = snapshot.value ?? {}
    setApiKeyEnv(current.apiKeyEnv ?? DEFAULT_REF)
    setBaseURL(current.baseURL ?? DEFAULT_BASE_URL)
    setModels(rowsFromValue(current))
    setModelsMode(Array.isArray(current.models) && current.models.length > 0 ? 'custom' : 'inherit')
    setImageModel(current.imageDefaultModel ?? '')
  }, [snapshot.revision, snapshot.status, dirty])

  /**
   * Read the chat catalog through the provider's own discovery surface. The
   * saved credential answers when the card has no typed key yet.
   * @param {{ baseURL?: string, apiKey?: string, report?: boolean }} options - draft endpoint and key.
   * @returns {Promise<object[]>} the discovered rows, or an empty list on failure.
   */
  const loadChatModels = async ({ baseURL: base, apiKey: key, report = false }) => {
    setCatalogLoading(true)
    try {
      const response = await props.mojie.ctx.remote.llm.discoverModels(NS, {
        provider: NS,
        ...(base === undefined || base === '' ? {} : { baseURL: base }),
        ...(key === undefined || key === '' ? {} : { apiKey: key }),
      })
      if (!response.ok) throw new Error(response.error?.message ?? '获取模型失败。')
      const known = (Array.isArray(response.value) ? response.value : []).flatMap((model) => {
        if (typeof model?.id !== 'string' || model.id.length === 0) return []
        return [{
          id: model.id,
          ...typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {},
          ...typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {},
          ...typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {},
          ...Array.isArray(model.inputModalities) && model.inputModalities.length > 0 ? { inputModalities: [...model.inputModalities] } : {},
        }]
      })
      setDiscovered(known)
      setCatalogError(known.length === 0 ? '主站没有列出任何模型，已自动填入内置快照。' : undefined)
      if (report) setStatus(`已获取 ${String(known.length)} 个模型。`)
      return known
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const missingCredential = /missing_credential|no credential|credential/iu.test(message)
      setCatalogError(missingCredential
        ? '尚未配置凭据，模型目录先使用内置快照；保存 API 密钥后会自动同步主站目录。'
        : `未能读取主站模型目录（${message}），已自动填入内置快照。`)
      if (report) setStatus(message)
      return []
    } finally {
      setCatalogLoading(false)
    }
  }

  // Best-effort warm-up once per saved endpoint: an offline host or a missing
  // key must not block the card, and the snapshot already fills every field.
  useEffect(() => {
    if (snapshot.status !== 'ready') return
    const base = (snapshot.value?.baseURL ?? DEFAULT_BASE_URL).trim()
    if (autoLoadBase.current === base) return
    autoLoadBase.current = base
    void loadChatModels({ baseURL: base })
  }, [snapshot.status, snapshot.value?.baseURL])

  const loadImageModels = async (report) => {
    setImageLoading(true)
    if (report) setStatus(undefined)
    try {
      const base = baseURL.trim()
      validateBaseURL(base)
      const response = await props.mojie.ctx.remote.llm.discoverModels(NS, {
        provider: NS,
        api: MEDIA_DISCOVERY_API,
        ...(base === '' ? {} : { baseURL: base }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      })
      if (!response.ok) throw new Error(response.error?.message ?? '获取图片模型失败。')
      const discoveredImageModels = Array.isArray(response.value) ? response.value : []
      const ids = discoveredImageModels
        .map((model) => model?.id)
        .filter((id) => typeof id === 'string' && id.length > 0)
      setImageModels(ids)
      if (report) setStatus(`已获取 ${String(ids.length)} 个图片模型。`)
    } catch (error) {
      if (report) setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setImageLoading(false)
    }
  }

  useEffect(() => {
    if (snapshot.status !== 'ready') return
    void loadImageModels(false)
  }, [snapshot.status])

  if (snapshot.status === 'loading') {
    return h('p', { className: cls.hint }, 'Mojie 设置加载中…')
  }
  if (snapshot.status === 'unavailable') {
    return h('p', { className: cls.hint }, '当前 Host 没有提供 Mojie 设置。')
  }
  if (!snapshot.writable) {
    return h('p', { className: cls.hint }, 'Mojie 设置当前为只读。')
  }

  const markDirty = () => {
    setDirty(true)
    setStatus(undefined)
  }
  /** The rows an edit starts from: the draft list, or the auto catalog. */
  const editableRows = () => (modelsMode === 'custom' ? models : autoRows.map((row) => ({ ...row, _capacity: {} })))

  const replaceRows = (next) => {
    setModels(next)
    setModelsMode('custom')
    markDirty()
  }

  const updateRowAt = (index, patch) => {
    replaceRows(editableRows().map((row, at) => (at === index ? patchRow(row, patch) : row)))
  }

  const removeRow = (index) => {
    replaceRows(editableRows().filter((_row, at) => at !== index))
    setExpandedRows((current) => {
      const next = new Set()
      for (const at of current) {
        if (at < index) next.add(at)
        else if (at > index) next.add(at - 1)
      }
      return next
    })
  }

  const addRow = () => {
    const rows = editableRows()
    replaceRows([...rows, { id: '', _capacity: {} }])
    setExpandedRows((current) => new Set([...current, rows.length]))
  }

  const resetModels = () => {
    setModels([])
    setModelsMode('inherit')
    setExpandedRows(new Set())
    markDirty()
    setStatus('已恢复自动模型目录，点击保存生效。')
  }

  const { rowErrors } = validateRows(displayRows)

  const capacityText = (row, field) => {
    const draft = row._capacity?.[field]
    if (typeof draft === 'string') return draft
    return formatCapacity(effectiveCapacity(row, field, metaById.get(row.id)))
  }

  const setCapacity = (index, field, text) => {
    const rows = editableRows()
    const row = rows[index]
    if (row === undefined) return
    const parsed = parseCapacity(text)
    replaceRows(rows.map((candidate, at) => at !== index ? candidate : patchRow(candidate, {
      [field]: Number.isNaN(parsed) ? undefined : parsed,
      _capacity: { ...(candidate._capacity ?? {}), [field]: text },
    })))
  }

  const setReasoningMode = (index, nextMode) => {
    const row = editableRows()[index]
    if (row === undefined) return
    if (nextMode === 'off') {
      updateRowAt(index, { reasoning: 'off', reasoningEfforts: undefined, defaultReasoningEffort: undefined })
      return
    }
    if (nextMode === 'auto') {
      updateRowAt(index, { reasoning: undefined, reasoningEfforts: undefined, defaultReasoningEffort: undefined })
      return
    }
    const ladder = effectiveReasoning(row) ?? autoReasoning(row.id)
    updateRowAt(index, {
      reasoning: undefined,
      reasoningEfforts: ladder === undefined ? ['medium'] : ladder.efforts.map((rung) => rung.id),
      defaultReasoningEffort: ladder?.defaultEffort,
    })
  }

  const setReasoningLevel = (index, levelIndex, level) => {
    const row = editableRows()[index]
    if (row === undefined) return
    const levels = [...declaredEfforts(row) ?? []]
    levels[levelIndex] = level
    const keepDefault = typeof row.defaultReasoningEffort === 'string' && levels.includes(row.defaultReasoningEffort)
      ? row.defaultReasoningEffort
      : undefined
    updateRowAt(index, {
      reasoningEfforts: levels,
      defaultReasoningEffort: keepDefault,
    })
  }

  const addReasoningLevel = (index) => {
    const row = editableRows()[index]
    if (row === undefined) return
    const levels = [...declaredEfforts(row) ?? []]
    const next = EFFORT_LEVELS.find((choice) => !levels.includes(choice))
    if (next === undefined) return
    updateRowAt(index, { reasoningEfforts: [...levels, next] })
  }

  const removeReasoningLevel = (index, levelIndex) => {
    const row = editableRows()[index]
    if (row === undefined) return
    const levels = [...declaredEfforts(row) ?? []]
    levels.splice(levelIndex, 1)
    const keepDefault = typeof row.defaultReasoningEffort === 'string' && levels.includes(row.defaultReasoningEffort)
      ? row.defaultReasoningEffort
      : undefined
    updateRowAt(index, {
      reasoningEfforts: levels.length === 0 ? undefined : levels,
      defaultReasoningEffort: keepDefault,
    })
  }

  const setDefaultLevel = (index, level) => {
    updateRowAt(index, { defaultReasoningEffort: level })
  }

  const reset = () => {
    const current = snapshot.value ?? {}
    setApiKeyEnv(current.apiKeyEnv ?? DEFAULT_REF)
    setBaseURL(current.baseURL ?? DEFAULT_BASE_URL)
    setModels(rowsFromValue(current))
    setModelsMode(Array.isArray(current.models) && current.models.length > 0 ? 'custom' : 'inherit')
    setImageModel(current.imageDefaultModel ?? '')
    setApiKey('')
    setKeyRevealed(false)
    setFetchOpen(false)
    setExpandedRows(new Set())
    setDirty(false)
    setStatus(undefined)
  }

  const save = async () => {
    setBusy(true)
    setStatus(undefined)
    try {
      const base = baseURL.trim()
      validateBaseURL(base)
      const keyFailure = apiKeyFailure(apiKey)
      if (keyFailure !== undefined) throw new Error(keyFailure)
      const issues = validateRows(displayRows)
      const firstError = [...issues.rowErrors.entries()][0]
      if (firstError !== undefined) {
        const position = displayRows.findIndex((row) => (typeof row.id === 'string' ? row.id.trim() : '') === firstError[0])
        throw new Error(position < 0 ? firstError[1] : `模型 ${String(position + 1)}：${firstError[1]}`)
      }
      const ref = apiKeyEnv.trim() || DEFAULT_REF
      // Always record the reference: the Models page and the Host's provider
      // readiness check join the stored credential through this field.
      if (!await form.set('apiKeyEnv', ref)) throw new Error('Host 拒绝写入 apiKeyEnv。')
      if (base === '') {
        if (!await form.unset('baseURL')) throw new Error('Host 拒绝清除 baseURL。')
      } else if (!await form.set('baseURL', base)) {
        throw new Error('Host 拒绝写入 baseURL。')
      }
      if (modelsMode === 'custom' && displayRows.length > 0) {
        if (!await form.set('models', displayRows.map(modelConfigFromRow))) throw new Error('Host 拒绝写入 models。')
      } else if (!await form.unset('models')) {
        throw new Error('Host 拒绝清除 models。')
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
        setKeyRevealed(false)
      }
      setDirty(false)
      setStatus('已保存。')
      // A saved key or endpoint is what discovery needs; refresh the catalog so
      // the auto-filled list follows the endpoint the user just confirmed.
      void loadChatModels({ baseURL: base })
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- fetch dialog
  const configuredNow = configuredIds
  const pickedDefault = (id) => modelsMode !== 'custom' || configuredNow.size === 0 || configuredNow.has(id)
  const isPicked = (id) => pickedDefault(id) !== fetchFlips.has(id)
  const normalizedQuery = fetchQuery.trim().toLowerCase()
  const visibleCandidates = normalizedQuery.length === 0
    ? candidates
    : candidates.filter((candidate) => candidate.id.toLowerCase().includes(normalizedQuery)
      || candidate.name?.toLowerCase().includes(normalizedQuery) === true)
  const allVisiblePicked = visibleCandidates.length > 0 && visibleCandidates.every((candidate) => isPicked(candidate.id))

  const openFetch = () => {
    setFetchOpen(true)
    setFetchQuery('')
    setFetchFlips(new Set())
    setFetchError(undefined)
    if (discovered === undefined && !catalogLoading) {
      void loadChatModels({ baseURL: baseURL.trim(), apiKey: apiKey.trim() })
    }
  }

  const toggleCandidate = (id) => {
    setFetchFlips((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const toggleVisible = () => {
    const target = !allVisiblePicked
    setFetchFlips((current) => {
      const next = new Set(current)
      for (const candidate of visibleCandidates) {
        if (pickedDefault(candidate.id) === target) next.delete(candidate.id)
        else next.add(candidate.id)
      }
      return next
    })
  }

  const adoptPicked = () => {
    const next = mergePickedModels(editableRows(), candidates, isPicked)
    if (next.length === 0) {
      setFetchError('请至少保留一个勾选的模型。')
      return
    }
    replaceRows(next.map((row) => ({ ...row, _capacity: row._capacity ?? {} })))
    setExpandedRows(new Set())
    setFetchOpen(false)
    setStatus(`已按所选模型更新列表（${String(next.length)} 个），点击保存生效。`)
  }

  const metaText = modelsMode === 'custom'
    ? `已自定义模型目录（${String(displayRows.length)} 个）；上下文窗口与推理等级自动填写`
    : `自动同步 /v1/models 与内置快照（${String(displayRows.length)} 个模型）；上下文窗口与推理等级自动填写`

  const statusIsSuccess = status !== undefined && (status.startsWith('已保存') || status.startsWith('已获取') || status.startsWith('已按') || status.startsWith('已恢复'))
  const imageOptions = imageOptionValues(imageModels, imageModel)

  return h('div', { className: cls.editor }, [
    h('div', { key: 'key', className: cls.field }, [
      h('span', { key: 'label', className: cls.fieldLabel }, 'API 密钥'),
      h('div', { key: 'control', className: cls.key }, [
        h(TextInput, {
          key: 'input',
          type: keyRevealed ? 'text' : 'password',
          autoComplete: 'new-password',
          value: apiKey,
          placeholder: props.keyConfigured === true ? '留空使用已保存凭据' : '粘贴 Mojie API Key',
          'aria-label': 'API 密钥',
          disabled: busy,
          style: { paddingRight: 40 },
          onChange: (event) => {
            setKeyRevealed(false)
            setApiKey(event.target.value)
            markDirty()
          },
        }),
        apiKey.length === 0 ? null : h('button', {
          key: 'toggle',
          type: 'button',
          className: cls.keyToggle,
          'aria-label': keyRevealed ? '隐藏密钥' : '显示密钥',
          'aria-pressed': keyRevealed,
          disabled: busy,
          onClick: () => setKeyRevealed((current) => !current),
        }, h(EyeIcon, { revealed: keyRevealed })),
      ]),
      h('span', {
        key: 'hint',
        className: props.keyConfigured === true ? cls.saved : cls.notice,
      }, props.keyConfigured === true
        ? `已配置凭据（${apiKeyEnv || DEFAULT_REF}）。`
        : '尚未配置凭据；模型目录先使用内置快照，保存密钥后可实时同步。'),
    ]),
    h('div', {
      key: 'advanced',
      className: cls.customized,
      'data-open': advancedOpen ? '' : undefined,
    }, [
      h('button', {
        key: 'summary',
        type: 'button',
        className: cls.summary,
        'aria-expanded': advancedOpen,
        onClick: () => setAdvancedOpen((current) => !current),
      }, '自定义设置'),
      h('div', {
        key: 'body',
        className: cls.customizedBody,
        hidden: !advancedOpen,
      }, [
        h('div', { key: 'identity', className: cls.fieldRow }, [
          h(Field, {
            key: 'provider',
            label: 'Provider ID',
            hint: '由插件固定，用于请求与凭据引用。',
          }, h(TextInput, { value: NS, disabled: true, readOnly: true })),
          h(Field, {
            key: 'display',
            label: '显示名称',
            hint: '模型选择器里展示的名字。',
          }, h(TextInput, { value: 'Mojie', disabled: true, readOnly: true })),
        ]),
        h(Field, {
          key: 'base',
          label: 'API 地址',
          hint: '站点根地址；带 /v1 或 www. 也能识别。',
        }, h(TextInput, {
          value: baseURL,
          placeholder: DEFAULT_BASE_URL,
          'aria-label': 'API 地址',
          disabled: busy,
          onChange: (event) => {
            setBaseURL(event.target.value)
            markDirty()
          },
        })),
        h(Field, {
          key: 'protocol',
          label: 'API 协议',
          hint: 'Mojie 的 /v1/Responses 接口由插件适配。',
        }, h(SelectInput, { value: 'openai-responses', disabled: true }, [
          h('option', { key: 'responses', value: 'openai-responses' }, 'OpenAI Responses'),
        ])),
        h(Field, {
          key: 'ref',
          label: '凭据引用',
          hint: '环境变量或凭据服务里的名字。',
        }, h(TextInput, {
          value: apiKeyEnv,
          placeholder: DEFAULT_REF,
          'aria-label': '凭据引用',
          disabled: busy,
          onChange: (event) => {
            setApiKeyEnv(event.target.value)
            markDirty()
          },
        })),
        h('section', { key: 'models', className: cls.modelCatalog, 'aria-label': '模型目录' }, [
          h('div', { key: 'head', className: cls.modelListHead }, [
            h('div', { key: 'heading', className: cls.modelCatalogHeading }, [
              h('span', { key: 'title', className: cls.modelCatalogTitle }, '模型目录'),
              h('span', { key: 'meta', className: cls.modelCatalogMeta }, metaText),
            ]),
            h('div', { key: 'actions', className: cls.modelHeadActions }, [
              modelsMode === 'custom' ? h(LinkButton, {
                key: 'reset',
                disabled: busy,
                onClick: resetModels,
              }, '恢复默认模型') : null,
              h(LinkButton, {
                key: 'fetch',
                disabled: busy || catalogLoading,
                onClick: openFetch,
              }, catalogLoading ? '获取中…' : '获取可用模型'),
            ]),
          ]),
          catalogLoading
            ? h('p', { key: 'loading', className: cls.hint }, '正在读取主站模型目录…')
            : catalogError === undefined ? null : h('p', { key: 'error', className: cls.hint }, catalogError),
          displayRows.length === 0 ? h('p', { key: 'empty', className: cls.empty }, '尚无模型。') : null,
          h('div', {
            key: 'list',
            className: cls.modelList,
            'data-scroll': displayRows.length > 12 ? '' : undefined,
          }, displayRows.map((row, index) => h(ModelRow, {
            key: String(index),
            row,
            meta: metaById.get(typeof row.id === 'string' ? row.id.trim() : row.id),
            position: index + 1,
            expanded: expandedRows.has(index),
            disabled: busy,
            error: rowErrors.get(typeof row.id === 'string' ? row.id.trim() : ''),
            contextWindowText: capacityText(row, 'contextWindow'),
            maxTokensText: capacityText(row, 'maxTokens'),
            onToggle: () => setExpandedRows((current) => {
              const next = new Set(current)
              if (!next.delete(index)) next.add(index)
              return next
            }),
            onField: (field, nextValue) => updateRowAt(index, { [field]: nextValue }),
            onCapacity: (field, text) => setCapacity(index, field, text),
            onModalities: (next) => updateRowAt(index, { inputModalities: next }),
            onReasoningMode: (next) => setReasoningMode(index, next),
            onReasoningLevel: (levelIndex, level) => setReasoningLevel(index, levelIndex, level),
            onAddLevel: () => addReasoningLevel(index),
            onRemoveLevel: (levelIndex) => removeReasoningLevel(index, levelIndex),
            onDefaultLevel: (level) => setDefaultLevel(index, level),
            onRemove: () => removeRow(index),
          }))),
          h('button', {
            key: 'add',
            type: 'button',
            className: cls.addModel,
            disabled: busy,
            onClick: addRow,
          }, [h(PlusIcon, { key: 'icon' }), '添加模型']),
        ]),
        h('div', { key: 'image', className: cls.field }, [
          h('span', { key: 'label', className: cls.fieldLabel }, '图片生成默认模型'),
          h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
            h(SelectInput, {
              key: 'select',
              value: imageOptions.includes(imageModel) ? imageModel : '',
              disabled: busy || imageLoading,
              style: { flex: '1 1 220px', minWidth: 200, maxWidth: 'none' },
              onChange: (event) => {
                setImageModel(event.target.value)
                markDirty()
              },
            }, [
              h('option', { key: 'placeholder', value: '' }, '（使用部署默认）'),
              ...imageOptions.map((id) => h('option', { key: id, value: id }, id)),
            ]),
            h(LinkButton, {
              key: 'refresh',
              disabled: busy || imageLoading,
              onClick: () => { void loadImageModels(true) },
            }, imageLoading ? '获取中…' : '刷新图片模型'),
          ]),
          h('span', { key: 'hint', className: cls.hint },
            `已选：${imageModel === '' ? '部署默认' : imageModel}；应用于 /image 与 mojie_generate_image，保存后生效。`),
          imageModels.length === 0
            ? h('span', { key: 'empty', className: cls.hint }, '还没有取到图片模型列表，点「刷新图片模型」获取。')
            : null,
        ]),
      ]),
    ]),
    status === undefined ? null : h('p', {
      key: 'status',
      role: 'status',
      'aria-live': 'polite',
      className: statusIsSuccess ? cls.saved : cls.error,
    }, status),
    h('div', { key: 'actions', className: cls.actions }, [
      h(SecondaryButton, { key: 'cancel', disabled: busy, onClick: reset }, '取消'),
      h(PrimaryButton, {
        key: 'save',
        disabled: busy || !dirty,
        onClick: () => { void save() },
      }, busy ? '保存中…' : '保存'),
    ]),
    h(Dialog, {
      key: 'fetch',
      open: fetchOpen,
      title: '选择模型',
      description: '以下是 Mojie 的可用模型，勾选的模型即为模型列表。',
      onClose: () => setFetchOpen(false),
      footer: [
        h(SecondaryButton, { key: 'cancel', onClick: () => setFetchOpen(false) }, '取消'),
        h(SecondaryButton, {
          key: 'adopt',
          disabled: visibleCandidates.length === 0 || catalogLoading,
          onClick: adoptPicked,
        }, '更新列表'),
      ],
    }, [
      h('div', { key: 'toolbar', className: cls.candidateToolbar }, [
        h(TextInput, {
          key: 'search',
          type: 'search',
          className: cls.candidateSearch,
          value: fetchQuery,
          placeholder: '搜索模型',
          'aria-label': '搜索模型',
          onChange: (event) => setFetchQuery(event.target.value),
        }),
        h(LinkButton, {
          key: 'all',
          disabled: visibleCandidates.length === 0,
          onClick: toggleVisible,
        }, allVisiblePicked ? '取消全选' : '全选'),
      ]),
      fetchError === undefined ? null : h('p', { key: 'error', className: cls.error, role: 'alert' }, fetchError),
      catalogLoading ? h('p', { key: 'loading', className: cls.candidateEmpty }, '正在读取主站模型目录…') : null,
      visibleCandidates.length === 0
        ? h('p', { key: 'empty', className: cls.candidateEmpty, role: 'status' }, '没有匹配的模型。')
        : h('ul', { key: 'list', className: cls.candidateList }, visibleCandidates.map((candidate) => h('li', {
          key: candidate.id,
        }, h('label', { className: cls.candidateLabel }, [
          h('input', {
            key: 'check',
            type: 'checkbox',
            checked: isPicked(candidate.id),
            onChange: () => toggleCandidate(candidate.id),
          }),
          h('span', {
            key: 'id',
            className: cls.candidateId,
            title: candidate.name ?? candidate.id,
          }, candidate.id),
        ])))),
    ]),
  ])
}

/**
 * Register the Mojie card under the Models page's keyed provider-card seat.
 * @param {object} ctx - the browser plugin context.
 */
export function apply(ctx) {
  ensureStyles()
  // Conversation rows for the image tools. The built-in client renders a picture
  // card only for `read_image`; without these keyed views a generated picture
  // stays in the Session log and the generic row shows its attachment JSON.
  registerMojieToolViews(ctx)
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
