/**
 * Browser primitives for the Mojie Models card.
 *
 * The core Models page draws its hand-written provider editors (“custom model
 * API”) with the shell's component library and CSS modules. A standalone plugin
 * cannot import those modules, so this file mirrors the same layout vocabulary
 * with the shell's design tokens: fields, inputs, link/primary/secondary
 * buttons, the collapsible “自定义设置” area, the model catalog rows, and the
 * fetch dialog. Keeping the markup and tokens in step is what makes the Mojie
 * card sit in the native page instead of looking bolted on.
 *
 * @module @mojieai/dsh-mojie-model-provider/client/native-ui
 */

import { createElement as h, useEffect, useId, useRef } from 'react'

/** Marker attribute so the stylesheet is injected exactly once per page. */
const STYLE_MARKER = '@mojieai/dsh-mojie-model-provider/card.css'

/**
 * Card stylesheet, derived from the shell's Models section CSS and expressed
 * with the same design tokens. Fallbacks keep the card legible on hosts that
 * renamed a token.
 */
const CARD_CSS = `
.mjz-editor{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:var(--dsw-radius-lg,8px);background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit)}
.mjz-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.mjz-fieldLabel{display:inline-flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;font-weight:500;line-height:18px}
.mjz-fieldRow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mjz-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:14px;line-height:22px}
.mjz-input:focus{border-color:var(--dsw-alias-state-business-primary,#4184f3);outline:none}
.mjz-input::placeholder{color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.8))}
.mjz-input:disabled{opacity:.6;cursor:default}
select.mjz-input{cursor:pointer;padding-right:32px;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px}
.mjz-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px}
.mjz-hint{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}
.mjz-notice{margin:0;color:var(--dsw-alias-state-warn-label,#c98a00);font-size:12px;line-height:18px}
.mjz-saved{margin:0;color:var(--dsw-alias-state-success-primary,#3aa76d);font-size:12px;line-height:18px}
.mjz-error{margin:0;color:var(--dsw-alias-state-error-primary,#e55353);font-size:12px;line-height:18px}
.mjz-tag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:16px}
.mjz-actions{display:flex;justify-content:flex-end;gap:8px}
.mjz-primary,.mjz-secondary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,6px);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.mjz-primary{border:none;background:var(--dsw-alias-button-primary-fill,#4184f3);color:var(--dsw-alias-label-primary-foreground,#fff)}
.mjz-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3273d8)}
.mjz-secondary{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:0 0;color:var(--dsw-alias-label-primary,inherit)}
.mjz-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.12))}
.mjz-link{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,4px);background:0 0;color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.mjz-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,inherit)}
.mjz-primary:disabled,.mjz-secondary:disabled,.mjz-link:disabled,.mjz-addModel:disabled,.mjz-icon:disabled{opacity:.4;cursor:default}
.mjz-primary:focus-visible,.mjz-secondary:focus-visible,.mjz-link:focus-visible,.mjz-icon:focus-visible,.mjz-addModel:focus-visible,.mjz-summary:focus-visible,.mjz-switch:focus-visible,.mjz-keyToggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4184f3))}
.mjz-icon{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,4px);background:0 0;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer}
.mjz-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,inherit)}
.mjz-iconDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,83,83,.14));color:var(--dsw-alias-state-error-primary,#e55353)}
.mjz-customized{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));padding-top:10px}
.mjz-summary{display:flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;border:none;border-radius:var(--dsw-radius-sm,4px);background:0 0;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;font-weight:500;line-height:18px;text-align:left;list-style:none;cursor:pointer}
.mjz-summary::-webkit-details-marker{display:none}
.mjz-summary::before{content:"";width:5px;height:5px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(-45deg) translate(-1px,-1px);transition:transform .12s}
.mjz-customized[data-open]>.mjz-summary::before{transform:rotate(45deg) translate(-1px,-1px)}
.mjz-summary:hover{color:var(--dsw-alias-label-primary,inherit)}
.mjz-customizedBody{display:flex;flex-direction:column;gap:12px;padding-top:12px}
.mjz-customizedBody[hidden]{display:none!important}
.mjz-modelCatalog{position:relative;display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.mjz-modelListHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.mjz-modelCatalogHeading{display:flex;flex-direction:column;gap:2px;min-width:0}
.mjz-modelCatalogTitle{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;font-weight:500;line-height:18px}
.mjz-modelCatalogMeta{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}
.mjz-modelHeadActions{display:inline-flex;align-items:center;gap:4px;flex:none}
.mjz-modelList{display:flex;flex-direction:column;gap:8px}
.mjz-modelList[data-scroll]{max-height:420px;overflow-y:auto;padding-right:2px}
.mjz-modelEntry{position:relative;padding:6px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));border-radius:var(--dsw-radius-lg,8px)}
.mjz-modelRow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px}
.mjz-modelAdvanced{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:2px 4px}
.mjz-modelField{display:flex;flex-direction:column;gap:4px;min-width:0}
.mjz-modelFieldLabel{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}
.mjz-modelInputTypes{grid-column:1/-1;min-width:0;margin:0;padding:0;border:none}
.mjz-modelInputTypes legend{margin-bottom:4px;padding:0}
.mjz-modelInputChoices{display:flex;flex-wrap:wrap;align-items:center;gap:16px;min-height:32px}
.mjz-modelReasoning{grid-column:1/-1;display:flex;flex-direction:column;gap:6px;min-width:0}
.mjz-modelReasoningHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mjz-modelReasoningRow{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px}
.mjz-efforts{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.mjz-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:999px;color:var(--dsw-alias-label-secondary,inherit);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px}
.mjz-chip[data-default]{border-color:var(--dsw-alias-state-business-primary,#4184f3);color:var(--dsw-alias-state-business-primary,#4184f3)}
.mjz-empty{margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-lg,8px);color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px;text-align:center}
.mjz-addModel{box-sizing:border-box;display:inline-flex;align-self:flex-start;align-items:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,4px);background:0 0;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.mjz-addModel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.mjz-key{position:relative}
.mjz-keyToggle{position:absolute;top:1px;right:1px;bottom:1px;display:inline-flex;align-items:center;justify-content:center;width:32px;padding:0;border:none;border-radius:var(--dsw-radius-md,6px);background:0 0;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.mjz-keyToggle:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit)}
.mjz-check{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px;cursor:pointer}
.mjz-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#4184f3)}
.mjz-switch{display:inline-flex;align-items:center;gap:8px;padding:0;border:none;background:0 0;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.mjz-switchTrack{position:relative;display:inline-block;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l4,rgba(127,127,127,.45));transition:background .12s}
.mjz-switch[aria-checked=true] .mjz-switchTrack{background:var(--dsw-alias-state-business-primary,#4184f3)}
.mjz-switchThumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .12s}
.mjz-switch[aria-checked=true] .mjz-switchThumb{transform:translateX(14px)}
.mjz-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.35)}
.mjz-dialog{display:flex;flex-direction:column;gap:12px;width:min(520px,100%);max-height:min(640px,calc(100vh - 48px));padding:18px 20px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-bg-module-platform,#1f1f1f);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 40px rgba(0,0,0,.35)}
.mjz-dialogHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.mjz-dialogTitle{margin:0;font-size:15px;font-weight:500;line-height:22px}
.mjz-dialogDescription{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}
.mjz-candidateToolbar{display:flex;align-items:center;gap:8px}
.mjz-candidateSearch{flex:1 1 240px;min-width:0}
.mjz-candidateList{display:flex;flex-direction:column;gap:2px;max-height:320px;margin:0;padding:0;overflow-y:auto;list-style:none}
.mjz-candidateLabel{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-md,6px);cursor:pointer}
.mjz-candidateLabel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.mjz-candidateId{flex:auto;min-width:0;overflow:hidden;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.mjz-candidateEmpty{margin:24px 0;color:var(--dsw-alias-label-secondary,inherit);font-size:13px;line-height:20px;text-align:center}
.mjz-dialogFooter{display:flex;justify-content:flex-end;gap:8px}
@media (max-width:520px){.mjz-fieldRow{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.mjz-summary::before,.mjz-switchThumb,.mjz-switchTrack{transition:none}}
`

/**
 * Inject the card stylesheet once per page. Server rendering has no document,
 * so the call is a no-op there.
 * @returns nothing.
 */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.head === undefined) return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_MARKER)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@mojieai/dsh-mojie-model-provider'
  tag.dataset.pluginCss = STYLE_MARKER
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}

/** Class-name helpers for the mirrored markup. */
export const cls = {
  editor: 'mjz-editor',
  field: 'mjz-field',
  fieldLabel: 'mjz-fieldLabel',
  fieldRow: 'mjz-fieldRow',
  input: 'mjz-input',
  mono: 'mjz-mono',
  hint: 'mjz-hint',
  notice: 'mjz-notice',
  saved: 'mjz-saved',
  error: 'mjz-error',
  tag: 'mjz-tag',
  actions: 'mjz-actions',
  primary: 'mjz-primary',
  secondary: 'mjz-secondary',
  link: 'mjz-link',
  icon: 'mjz-icon',
  iconDanger: 'mjz-iconDanger',
  customized: 'mjz-customized',
  summary: 'mjz-summary',
  customizedBody: 'mjz-customizedBody',
  modelCatalog: 'mjz-modelCatalog',
  modelListHead: 'mjz-modelListHead',
  modelCatalogHeading: 'mjz-modelCatalogHeading',
  modelCatalogTitle: 'mjz-modelCatalogTitle',
  modelCatalogMeta: 'mjz-modelCatalogMeta',
  modelHeadActions: 'mjz-modelHeadActions',
  modelList: 'mjz-modelList',
  modelEntry: 'mjz-modelEntry',
  modelRow: 'mjz-modelRow',
  modelAdvanced: 'mjz-modelAdvanced',
  modelField: 'mjz-modelField',
  modelFieldLabel: 'mjz-modelFieldLabel',
  modelInputTypes: 'mjz-modelInputTypes',
  modelInputChoices: 'mjz-modelInputChoices',
  modelReasoning: 'mjz-modelReasoning',
  modelReasoningHead: 'mjz-modelReasoningHead',
  modelReasoningRow: 'mjz-modelReasoningRow',
  efforts: 'mjz-efforts',
  chip: 'mjz-chip',
  empty: 'mjz-empty',
  addModel: 'mjz-addModel',
  key: 'mjz-key',
  keyToggle: 'mjz-keyToggle',
  check: 'mjz-check',
  switch: 'mjz-switch',
  switchTrack: 'mjz-switchTrack',
  switchThumb: 'mjz-switchThumb',
  overlay: 'mjz-overlay',
  dialog: 'mjz-dialog',
  dialogHeader: 'mjz-dialogHeader',
  dialogTitle: 'mjz-dialogTitle',
  dialogDescription: 'mjz-dialogDescription',
  candidateToolbar: 'mjz-candidateToolbar',
  candidateSearch: 'mjz-candidateSearch',
  candidateList: 'mjz-candidateList',
  candidateLabel: 'mjz-candidateLabel',
  candidateId: 'mjz-candidateId',
  candidateEmpty: 'mjz-candidateEmpty',
  dialogFooter: 'mjz-dialogFooter',
}

/**
 * One labelled form field.
 * @param {object} props - label, optional hint/error, and the control.
 * @returns {object} the field element.
 */
export function Field({ label, hint, error, children }) {
  return h('label', { className: cls.field }, [
    h('span', { key: 'label', className: cls.fieldLabel }, label),
    h('span', { key: 'control' }, children),
    hint === undefined ? null : h('span', { key: 'hint', className: cls.hint }, hint),
    error === undefined ? null : h('span', { key: 'error', className: cls.error, role: 'alert' }, error),
  ])
}

/**
 * A text input with the card's standard styling.
 * @param {object} props - forwarded `<input>` attributes.
 * @returns {object} the input element.
 */
export function TextInput({ className, ...props }) {
  return h('input', { ...props, className: className === undefined ? cls.input : `${cls.input} ${className}` })
}

/**
 * A select with the card's standard styling.
 * @param {object} props - forwarded `<select>` attributes.
 * @returns {object} the select element.
 */
export function SelectInput({ className, ...props }) {
  return h('select', { ...props, className: className === undefined ? cls.input : `${cls.input} ${className}` })
}

/**
 * One inline link button.
 * @param {object} props - forwarded `<button>` attributes.
 * @returns {object} the button element.
 */
export function LinkButton({ className, ...props }) {
  return h('button', { type: 'button', ...props, className: className === undefined ? cls.link : `${cls.link} ${className}` })
}

/**
 * The commit button.
 * @param {object} props - forwarded `<button>` attributes.
 * @returns {object} the button element.
 */
export function PrimaryButton({ className, ...props }) {
  return h('button', { type: 'button', ...props, className: className === undefined ? cls.primary : `${cls.primary} ${className}` })
}

/**
 * The cancel/secondary button.
 * @param {object} props - forwarded `<button>` attributes.
 * @returns {object} the button element.
 */
export function SecondaryButton({ ...props }) {
  return h('button', { type: 'button', ...props, className: cls.secondary })
}

/**
 * A square icon button.
 * @param {object} props - `danger` plus forwarded `<button>` attributes.
 * @returns {object} the button element.
 */
export function IconButton({ danger = false, ...props }) {
  return h('button', {
    type: 'button',
    ...props,
    className: danger ? `${cls.icon} ${cls.iconDanger}` : cls.icon,
  })
}

/**
 * A checkbox with its label.
 * @param {object} props - `label`, `checked`, `onChange`, `disabled`.
 * @returns {object} the labelled checkbox.
 */
export function Checkbox({ label, checked, onChange, disabled }) {
  return h('label', { className: cls.check }, [
    h('input', {
      key: 'input',
      type: 'checkbox',
      checked,
      disabled,
      onChange: event => onChange(event.target.checked),
    }),
    h('span', { key: 'label' }, label),
  ])
}

/**
 * A labelled toggle rendered as a button with `role="switch"`.
 * @param {object} props - `checked`, `onChange`, `label`, `disabled`.
 * @returns {object} the switch element.
 */
export function Switch({ checked, onChange, label, disabled = false }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    disabled,
    className: cls.switch,
    onClick: () => onChange(!checked),
  }, [
    h('span', { key: 'track', className: cls.switchTrack, 'aria-hidden': 'true' }, [
      h('span', { key: 'thumb', className: cls.switchThumb }),
    ]),
    h('span', { key: 'label' }, label),
  ])
}

/**
 * One small rounded level pill.
 * @param {object} props - text plus an optional `isDefault`.
 * @returns {object} the chip element.
 */
export function Chip({ children, isDefault = false, title }) {
  return h('span', { className: cls.chip, 'data-default': isDefault ? '' : undefined, title }, children)
}

/** Inline chevron pointing right when collapsed, down when expanded. */
export function ChevronIcon({ expanded }) {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4' }))
}

/** Inline trash icon. */
export function TrashIcon() {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, [
    h('path', { key: 'lid', d: 'M3 4.5h10' }),
    h('path', { key: 'body', d: 'M5 4.5V3.2h6v1.3M4.2 4.5l.6 8.3h6.4l.6-8.3' }),
  ])
}

/** Inline plus icon. */
export function PlusIcon() {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: 'M8 3.5v9M3.5 8h9' }))
}

/**
 * The eye toggle used by the write-only key field.
 * @param {object} props - `revealed` and an optional size.
 * @returns {object} the eye svg.
 */
export function EyeIcon({ revealed }) {
  const contour = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
    'aria-hidden': 'true',
  }, h('path', {
    d: revealed ? `${contour}M2.5 2.5L13.5 13.5` : `${contour}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`,
  }))
}

/**
 * A modal dialog in the page's visual language. Rendered in place (no portal)
 * so server rendering and tests stay simple; the overlay is fixed.
 * @param {object} props - `open`, `title`, `description`, `onClose`, `footer`, children.
 * @returns {object|null} the dialog, or null while closed.
 */
export function Dialog({ open, title, description, onClose, footer, children }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown)
    dialogRef.current?.focus?.()
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])
  if (!open) return null
  return h('div', {
    className: cls.overlay,
    onMouseDown: (event) => {
      if (event.target === event.currentTarget) onClose?.()
    },
  }, h('div', {
    className: cls.dialog,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabIndex: -1,
    ref: dialogRef,
  }, [
    h('div', { key: 'header', className: cls.dialogHeader }, [
      h('div', { key: 'text' }, [
        h('h3', { key: 'title', id: titleId, className: cls.dialogTitle }, title),
        description === undefined ? null : h('p', { key: 'desc', className: cls.dialogDescription }, description),
      ]),
      h(IconButton, {
        key: 'close',
        'aria-label': '关闭',
        title: '关闭',
        onClick: onClose,
      }, '×'),
    ]),
    h('div', { key: 'body' }, children),
    footer === undefined ? null : h('div', { key: 'footer', className: cls.dialogFooter }, footer),
  ]))
}
