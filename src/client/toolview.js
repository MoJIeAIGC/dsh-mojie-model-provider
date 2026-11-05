/**
 * Conversation rows for the Mojie image tools.
 *
 * The built-in Web Client renders a picture card only for `read_image`
 * (`imageCardModel` requires that exact wire name) and flattens every other
 * image block into JSON inside the generic row. A generated picture therefore
 * never appeared as a picture in the chat.
 *
 * A business package owns its own wire names, so this module registers keyed
 * `tool.call.toolview` rows for the four Mojie tools. A generated picture is a
 * real file in the Session directory — the provider's exact bytes — so the row
 * reads that file through the Session filesystem and shows it; the durable
 * attachment gallery is used only when the tool had to fall back to the
 * attachment store.
 *
 * @module @mojieai/dsh-mojie-model-provider/client/toolview
 */

import { createElement as h, useEffect, useMemo, useState } from 'react'

/** Wire tool name -> collapsed-row title. Registration iterates these keys. */
const TOOL_TITLES = {
  mojie_generate_image: '生成图片',
  mojie_edit_image: '编辑图片',
  mojie_image_task: '图片任务',
}

/** Media types a durable image block may claim, mirroring `ImageMediaType`. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Positive-integer guard shared by the byte and pixel measures. */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** First physical line of a prompt or message, trimmed for a summary row. */
function firstLine(text) {
  const line = text.split('\n').find((entry) => entry.trim() !== '') ?? text
  return line.trim().slice(0, 120)
}

/** Parse legacy `argsRaw` without letting malformed arguments break the row. */
function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Narrow the durable image references carried by a settled result.
 *
 * The result content is the single source of truth: it is what the tool
 * returned and what a post-execute policy would replace. Replay reaches this
 * with unvalidated wire data, so one malformed block declines the whole gallery
 * instead of rendering a partial one — the row then keeps the text envelope.
 * @param {readonly object[] | undefined} content - result content blocks.
 * @returns {object[]} valid attachment references, in order.
 */
export function imageReferences(content) {
  const refs = []
  for (const part of content ?? []) {
    if (typeof part !== 'object' || part === null || part.type !== 'image') continue
    const attachment = part.attachment
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) return []
    const { attachmentId, mediaType, bytes, width, height, name } = attachment
    if (typeof attachmentId !== 'string' || attachmentId === '') return []
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) return []
    if (!positiveInteger(bytes) || !positiveInteger(width) || !positiveInteger(height)) return []
    if (name !== undefined && typeof name !== 'string') return []
    refs.push(name === undefined
      ? { attachmentId, mediaType, bytes, width, height }
      : { attachmentId, mediaType, bytes, width, height, name })
  }
  return refs
}

/**
 * Narrow the workspace originals the tool wrote, from its persisted metadata.
 * @param {object | undefined} meta - presentation metadata of unknown shape.
 * @returns {object[]} validated files, in order.
 */
export function workspaceFiles(meta) {
  const raw = meta !== null && typeof meta === 'object' ? meta.files : undefined
  if (!Array.isArray(raw)) return []
  const files = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    if (typeof item.path !== 'string' || item.path === '') continue
    files.push({
      path: item.path,
      mediaType: typeof item.media_type === 'string' ? item.media_type : 'image/png',
      bytes: positiveInteger(item.bytes) ? item.bytes : undefined,
      width: positiveInteger(item.width) ? item.width : undefined,
      height: positiveInteger(item.height) ? item.height : undefined,
    })
  }
  return files
}

/**
 * Narrow the provider URLs the tool recorded, from its persisted metadata.
 * They are the reference that exists even when no local copy does.
 * @param {object | undefined} meta - presentation metadata of unknown shape.
 * @returns {string[]} validated URLs, in order.
 */
export function providerUrls(meta) {
  const raw = meta !== null && typeof meta === 'object' ? meta.urls : undefined
  if (!Array.isArray(raw)) return []
  return raw.filter((url) => typeof url === 'string' && url !== '')
}

/** Joined text blocks of a settled result, excluding the leading brief. */
function resultLines(content) {
  const lines = []
  for (const part of content ?? []) {
    if (typeof part !== 'object' || part === null || part.type !== 'text' || typeof part.text !== 'string') continue
    for (const line of part.text.split('\n')) if (line.trim() !== '') lines.push(line)
  }
  return lines
}

/**
 * Derive the row model from one call block.
 *
 * `preparing`/`start` blocks carry no content yet; a `result` block is
 * recognized by its `kind` field. Every field is read defensively because
 * replay may hand over an older or hand-edited record.
 * @param {object} block - stage-specific block from the toolview owner props.
 * @returns {object} the presentational model.
 */
export function mojieRowModel(block) {
  const settled = 'kind' in block
  const args = parseArgs((settled ? block.call?.argsRaw : block.argsRaw) ?? '')
  const content = settled ? block.content ?? [] : []
  const files = settled && block.isError !== true ? workspaceFiles(block.meta) : []
  const urls = settled && block.isError !== true ? providerUrls(block.meta) : []
  const attachments = settled && block.isError !== true ? imageReferences(content) : []
  const error = settled && block.isError === true
  const stopped = settled && block.error?.code === 'interrupted'
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  return {
    settled,
    error,
    stopped,
    files,
    urls,
    attachments,
    args,
    prompt,
    taskId: typeof args.task_id === 'string' ? args.task_id : '',
    lines: settled ? resultLines(content) : [],
    output: settled ? resultLines(content).join('\n') : '',
    errorText: error ? errorSummary(block) : '',
  }
}

/** One-line failure text for the collapsed row. */
function errorSummary(block) {
  const lines = resultLines(block.content)
  if (lines.length > 0) return lines[0]
  if (typeof block.error?.message === 'string' && block.error.message !== '') return block.error.message
  return '调用失败'
}

/** Small leading glyph; no primitives import so the bundle stays self-contained. */
function Glyph() {
  return h('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    'aria-hidden': 'true',
  }, [
    h('rect', { key: 'r', x: 1.8, y: 2.6, width: 12.4, height: 10.8, rx: 2 }),
    h('circle', { key: 'c', cx: 5.4, cy: 6.2, r: 1.2 }),
    h('path', { key: 'p', d: 'M2.4 11.6l3.4-3.2 2.6 2.3 2.4-2.7 3 3.6' }),
  ])
}

/** File name without its directories, for an accessible label. */
function baseName(path) {
  const normalized = String(path).replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

/** Media type from a file extension; the workspace read does not report one. */
function mediaTypeFor(path) {
  const name = baseName(path).toLowerCase()
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

/**
 * Read one Session file and hand it to the browser as an object URL.
 *
 * The loader is created once per plugin instance; the cache keeps repeats of
 * the same picture (re-renders, collapsed/expanded toggles) to one read.
 * @param {object} ctx - browser plugin context.
 * @param {string} sessionId - Session that owns the working directory.
 * @param {string} path - absolute path or workspace-relative path.
 * @returns {Promise<string>} a `blob:` URL usable by `<img>`.
 */
function createWorkspaceLoader(ctx) {
  const cache = new Map()
  return (sessionId, path) => {
    const key = `${sessionId}|${path}`
    let pending = cache.get(key)
    if (pending === undefined) {
      pending = readWorkspaceBytes(ctx, sessionId, path).then(({ data, mediaType }) =>
        URL.createObjectURL(new Blob([data], { type: mediaType })))
      pending.catch(() => { cache.delete(key) })
      cache.set(key, pending)
    }
    return pending
  }
}

/** One `readBytes` round-trip through the Session filesystem. */
async function readWorkspaceBytes(ctx, sessionId, path) {
  const remote = typeof ctx.get === 'function' ? ctx.get('remote.workspaceFiles') : undefined
  const workspaceFiles = remote ?? ctx.remote?.workspaceFiles
  if (workspaceFiles === undefined) throw new Error('workspace file reads are unavailable')
  const result = await workspaceFiles.readBytes(sessionId, path, {})
  if (!result?.ok) throw new Error(result?.error?.message ?? 'workspace file read failed')
  const data = result.value?.data
  if (!(data instanceof Uint8Array)) throw new Error('workspace file read returned no bytes')
  return { data, mediaType: mediaTypeFor(path) }
}

/**
 * Load one durable attachment for the fallback grid.
 *
 * The shared gallery usually renders these; when the composition has no
 * `tool.call.images` slot, rendering `<img src={undefined}>` would silently
 * show nothing, so this loader keeps the preview working on its own.
 */
function AttachmentImage({ attachment, loadImage }) {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    if (typeof loadImage !== 'function') {
      setState({ status: 'unsupported' })
      return undefined
    }
    let live = true
    setState({ status: 'loading' })
    loadImage(attachment)
      .then((url) => { if (live) setState({ status: 'ready', url }) })
      .catch(() => { if (live) setState({ status: 'failed' }) })
    return () => { live = false }
  }, [attachment, loadImage])
  if (state.status === 'ready') {
    return h('img', {
      src: state.url,
      alt: attachment.name ?? 'Mojie image',
      style: { maxWidth: 240, maxHeight: 240, borderRadius: 8, objectFit: 'cover' },
    })
  }
  const label = state.status === 'failed'
    ? '图片加载失败'
    : state.status === 'unsupported' ? '当前视图不能预览' : '图片加载中…'
  return h('span', { style: { fontSize: 12, opacity: 0.7 } }, label)
}

/** Shared slot gallery, or a local `<img>` grid when the slot is absent. */
function Gallery({ images, loadImage, renderSlot }) {
  // The shared gallery is used for workspace previews (they carry a URL). A
  // durable attachment is loaded here directly: in compositions where the
  // slot silently ignores attachment entries the row would otherwise show no
  // picture at all.
  const hasAttachment = images.some((entry) => entry.attachment !== undefined)
  if (!hasAttachment && typeof renderSlot === 'function') {
    try {
      const rendered = renderSlot('tool.call.images', { images, loadImage, align: 'start' })
      if (rendered) return rendered
    } catch {
      // A composition without the attachment gallery falls through to the
      // local previews below instead of failing the whole tool row.
    }
  }
  return h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
    images.map((entry, index) => entry.attachment === undefined
      ? h('img', {
        key: `${entry.preview?.url ?? index}`,
        src: entry.preview?.url,
        alt: entry.preview?.name ?? 'Mojie image',
        style: { maxWidth: 240, maxHeight: 240, borderRadius: 8, objectFit: 'cover' },
      })
      : h(AttachmentImage, {
        key: `${entry.attachment.attachmentId}`,
        attachment: entry.attachment,
        loadImage,
      })))
}

/**
 * Workspace originals: read each file, then show it through the shared gallery.
 *
 * A preview entry carries its own URL, so the gallery needs no attachment and
 * the picture stays exactly the file the tool wrote.
 * @param {object} props - files, the Session-bound loader, and the slot renderer.
 * @returns {object | null} the gallery, a loading line, or a failure line.
 */
function WorkspaceImages({ files, load, renderSlot, openFile }) {
  const [images, setImages] = useState(null)
  const [failure, setFailure] = useState(false)
  const key = files.map((file) => file.path).join('\n')
  useEffect(() => {
    let live = true
    setImages(null)
    setFailure(false)
    Promise.all(files.map(async (file) => {
      const url = await load(file.path)
      return {
        preview: {
          url,
          name: baseName(file.path),
          ...file.width === undefined ? {} : { width: file.width },
          ...file.height === undefined ? {} : { height: file.height },
        },
      }
    })).then((value) => {
      if (live) setImages(value)
    }).catch(() => {
      if (live) setFailure(true)
    })
    return () => { live = false }
    // `key` identifies the file set; `load` is stable for a Session.
  }, [key, load])
  if (failure || typeof load !== 'function') {
    return h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } }, [
      h('div', { key: 'hint' }, '图片已保存到工作目录（当前视图不能预览）：'),
      ...files.map((file) => h('div', {
        key: file.path,
        style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 },
      }, [
        h('code', { key: 'path', style: { wordBreak: 'break-all' } }, file.path),
        typeof openFile === 'function'
          ? h('button', {
            key: 'open',
            type: 'button',
            onClick: (event) => { event.stopPropagation(); openFile(file.path) },
            style: { padding: 0, border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' },
          }, '打开')
          : null,
      ])),
    ])
  }
  if (images === null) return h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.7 } }, '图片加载中…')
  return h('div', null, [
    h(Gallery, {
      key: 'gallery',
      images,
      // A preview entry never calls the attachment loader; the gallery still
      // requires the prop.
      loadImage: () => Promise.reject(new Error('preview entry')),
      renderSlot,
    }),
    files.length === 0
      ? null
      : h('div', { key: 'files', style: { marginTop: 4, fontSize: 12, opacity: 0.7 } },
        files.map((file) => baseName(file.path)).join(' · ')),
  ])
}

/** Durable attachment fallback: the official gallery with the session loader. */
function StoredImages({ attachments, loadImage, renderSlot }) {
  const images = useMemo(() => attachments.map((attachment) => ({ attachment })), [attachments])
  if (typeof loadImage !== 'function') {
    return h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.75 } },
      `已保存 ${images.length} 张图片到附件（当前视图不能预览）`)
  }
  return h(Gallery, { images, loadImage, renderSlot })
}

/** Details disclosure: task id, status, per-image size, and any provider note. */
function Details({ model, open, onToggle }) {
  if (model.lines.length === 0) return null
  return h('div', { style: { marginTop: 2 } }, [
    h('button', {
      key: 'toggle',
      type: 'button',
      onClick: onToggle,
      'aria-expanded': open,
      style: {
        padding: 0,
        border: 'none',
        background: 'none',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        opacity: 0.75,
        cursor: 'pointer',
      },
    }, open ? '收起详情' : '查看详情'),
    open
      ? h('pre', {
        key: 'body',
        style: {
          margin: '4px 0 0',
          padding: '6px 8px',
          border: '0.5px solid var(--dsw-alias-border-l1, #444)',
          borderRadius: 6,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          opacity: 0.85,
        },
      }, model.output)
      : null,
  ])
}

/**
 * Render one Mojie image call.
 *
 * The settled body shows the pictures themselves without requiring a click:
 * the whole point of a generation call is the picture, and the generic row
 * (which this view replaces) would only ever show its attachment JSON.
 * @param {object} props - keyed toolview payload, including the injected loader.
 * @returns {object} the row element.
 */
export function MojieImageRow(props) {
  const { block, toolName } = props
  const model = useMemo(() => mojieRowModel(block ?? {}), [block])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const title = TOOL_TITLES[toolName] ?? 'Mojie 图片'
  const summary = model.error
    ? model.errorText
    : model.stopped
      ? '已中止'
      : model.prompt !== ''
        ? firstLine(model.prompt)
        : model.taskId !== ''
          ? model.taskId
          : model.settled
            ? '已完成'
            : ''

  // The attachment is the display copy: it is already small enough for the
  // chat and renders exactly as stored. Reading the (possibly much larger)
  // workspace original is only the fallback when no display copy exists.
  const pictures = model.attachments.length > 0
    ? h(StoredImages, {
      attachments: model.attachments,
      loadImage: props.loadImage,
      renderSlot: props.renderSlot,
    })
    : model.files.length > 0
      ? h(WorkspaceImages, {
        files: model.files,
        load: props.loadWorkspaceImage,
        renderSlot: props.renderSlot,
        openFile: props.openFile,
      })
      : null

  return h('div', {
    'data-tool': toolName,
    'data-state': model.error ? 'error' : model.stopped ? 'stopped' : model.settled ? 'ok' : 'running',
    style: { display: 'flex', flexDirection: 'column' },
  }, [
    h('div', {
      key: 'row',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        minHeight: 24,
        fontSize: 13,
        color: 'var(--dsw-alias-label-tertiary, #999)',
        overflow: 'hidden',
      },
    }, [
      h('span', {
        key: 'icon',
        style: { display: 'inline-flex', flex: 'none', alignItems: 'center', marginRight: 2 },
      }, h(Glyph)),
      h('span', { key: 'title', style: { flex: 'none' } }, title),
      summary === '' ? null : h('span', {
        key: 'sep',
        'aria-hidden': 'true',
        style: { flex: 'none', width: 2, height: 2, borderRadius: 1, margin: '0 8px', background: 'var(--dsw-alias-label-caption, #666)' },
      }),
      summary === '' ? null : h('span', {
        key: 'summary',
        style: {
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: model.error ? 'var(--dsw-alias-state-error-primary, #e66)' : 'inherit',
        },
      }, summary),
    ]),
    pictures === null
      ? null
      : h('div', { key: 'pictures', style: { marginLeft: 22 } }, pictures),
    // The saved original is always named in the row itself: the model may or
    // may not relay it, and a path in the details disclosure is too easy to
    // miss. `title` keeps the full text available for a truncated line.
    model.settled && model.files.length > 0
      ? h('div', {
        key: 'originals',
        title: model.files.map((file) => file.path).join('\n'),
        style: {
          marginLeft: 22,
          marginTop: 4,
          fontSize: 12,
          opacity: 0.75,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          wordBreak: 'break-all',
        },
      }, model.files.length === 1
        ? `原图：${model.files[0].path}`
        : `原图：${model.files[0].path} 等 ${model.files.length} 张`)
      : null,
    // The provider URL is the reference that survives a missing local copy and
    // stays editable without the normalized display copy.
    model.settled && model.urls.length > 0
      ? h('div', {
        key: 'urls',
        title: model.urls.join('\n'),
        style: {
          marginLeft: 22,
          marginTop: 2,
          fontSize: 12,
          opacity: 0.65,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, model.urls.length === 1
        ? `URL：${model.urls[0]}`
        : `URL：${model.urls[0]} 等 ${model.urls.length} 个`)
      : null,
    model.settled && !model.error && pictures === null && model.stopped === false
      ? h('div', {
        key: 'pending',
        style: { marginLeft: 22, fontSize: 12, opacity: 0.75, marginTop: 2 },
      }, model.lines[model.lines.length - 1] ?? '')
      : null,
    h('div', { key: 'details', style: { marginLeft: 22 } }, h(Details, {
      model,
      open: detailsOpen,
      onToggle: () => setDetailsOpen((value) => !value),
    })),
  ])
}

/**
 * Register the keyed rows. Mount inside a client context carrying `slots`.
 * @param {object} ctx - browser plugin context.
 */
export function registerMojieToolViews(ctx) {
  const loadWorkspaceImage = createWorkspaceLoader(ctx)
  for (const key of Object.keys(TOOL_TITLES)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      inject: (sessionId) => ({
        sessionId,
        loadWorkspaceImage: (path) => loadWorkspaceImage(sessionId, path),
      }),
    }, MojieImageRow))
  }
}
