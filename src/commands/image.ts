import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { createUserMessage, type ContentBlock, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_IMAGE_MODEL, type ResolvedConfig } from '../config.js'
import { chooseImageModel, rememberImageModel } from '../media/model-memory.js'
import { advancedParameterSummary, IMAGE_PARAMETER_DOC_URL, type AdvancedImageParameters } from '../media/parameters.js'
import { storeTask, taskText, toImageRef } from '../media/task-store.js'
import { INPUT_CONCURRENCY, prepareImageBytes } from '../media/input-image.js'
import type { MojieMediaClient, MojieMediaTask } from '../media/client.js'

/**
 * `/image` — the dedicated, user-invoked image entry.
 *
 * A slash command runs directly against the agent without a model message, so
 * the prompt here goes to the image gateway verbatim (no model rewrite, no
 * tool-selection guess) and the finished picture is steered into the
 * conversation as a durable image message. Model choice is a first-class part
 * of the grammar: `--model` for one call, `/image model <id>` to persist the
 * deployment field the Settings dropdown also edits.
 *
 * @module @mojieai/dsh-mojie-model-provider/commands/image
 */

/** Command name without the leading slash. */
export const IMAGE_COMMAND_NAME = 'image'

/** One command's delivery context, also used by the background watcher. */
type ImageCommandContext =
  | { readonly kind: 'generate'; readonly referenceCount: number }
  | { readonly kind: 'task' }

/** Tasks whose background watcher is still running. */
const activeTasks = new Set<string>()
/** Background deliveries; tests await them through {@link waitForImageJobs}. */
const imageJobs = new Set<Promise<void>>()

/** Track one background delivery so tests (and shutdown) can wait for it. */
export function trackImageJob(job: Promise<void>): void {
  imageJobs.add(job)
  void job.finally(() => { imageJobs.delete(job) })
}

/** Wait until every tracked background delivery has settled. */
export async function waitForImageJobs(): Promise<void> {
  while (imageJobs.size > 0) await Promise.allSettled([...imageJobs])
}

/** A user-role text message for a background failure notice. */
function textMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Host wiring the command needs. */
export interface ImageCommandOptions {
  /** Read the live plugin configuration for one call. */
  readonly config: () => ResolvedConfig
  /** Build a media client bound to the live configuration and credential. */
  readonly media: () => Promise<MojieMediaClient>
  /** Durable attachment store; without it the picture is delivered as a link. */
  readonly attachments: () => AttachmentStore | undefined
  /** Settings namespace (profile entry id) that owns the image default. */
  readonly settingsNamespace: string
}

type Parsed =
  | { readonly kind: 'help' }
  | { readonly kind: 'models' }
  | { readonly kind: 'model'; readonly model?: string }
  | { readonly kind: 'task'; readonly taskId?: string }
  | {
    readonly kind: 'generate'
    readonly prompt: string
    readonly model?: string
    readonly resolution?: string
    readonly aspectRatio?: string
    /** Model-specific extras parsed from the advanced flags. */
    readonly advanced?: AdvancedImageParameters
  }

/**
 * Register `/image` on the calling context's `ctx.commands`.
 * @param ctx - context carrying the `commands` service.
 * @param options - configuration, media-client factory, attachments, settings namespace.
 */
export function registerImageCommand(ctx: Context, options: ImageCommandOptions): void {
  const commands: CommandRuntime = ctx.commands
  // The provider original belongs to the Session's current directory; the
  // attachment is only the display copy steered into the conversation.
  const sessionDirectory = async (agent: Agent, signal: AbortSignal): Promise<string | undefined> => {
    const workingDirectory = ctx.get('workingDirectory') as {
      ensure?(agent: unknown, signal?: AbortSignal): Promise<string>
    } | undefined
    if (workingDirectory?.ensure === undefined) return undefined
    try {
      return await workingDirectory.ensure(agent, signal)
    } catch {
      return undefined
    }
  }
  commands.register({
    name: IMAGE_COMMAND_NAME,
    // Host commands get no icon slot from the current client (its glyph table is
    // first-party only), so the pictogram rides the description line instead.
    description: '🖼 用 Mojie 生成或编辑图片（附带图片＝编辑；可直接指定模型；结果放进对话）',
    input: {
      hint: '<描述> [--model <id>] [--resolution 2K] [--ratio 1:1]（高级参数见 /image help；附带图片即为编辑）| models | model [<id>] | task <id>',
      attachments: true,
    },
    async handler({ agent, rawInput, signal, attachments }) {
      const parsed = parseImageCommand(rawInput)
      const config = options.config()
      const current = config.imageDefaultModel
      const imageBlocks = attachments.filter((block): block is ImageBlock => block.type === 'image')
      const fileCount = attachments.length - imageBlocks.length

      // Grammar commands never consume attachments: choosing a model or looking
      // at help/status must keep working while images are staged, so anything
      // submitted alongside is silently dropped rather than rejected.
      switch (parsed.kind) {
        case 'help':
          return { kind: 'success', text: usage(config) }
        case 'models':
          return { kind: 'success', text: await describeModels(options, current, signal) }
        case 'model':
          return await chooseModel(ctx, options, agent, parsed.model, current, signal)
        case 'task':
          if (parsed.taskId === undefined) {
            return { kind: 'error', text: '用法：/image task <task_id>（task_id 来自超时返回的 processing 任务）' }
          }
          if (activeTasks.has(parsed.taskId)) {
            return { kind: 'success', text: `任务 ${parsed.taskId} 正在生成，完成后会自动放进对话。` }
          }
          try {
            return await deliverTask(options, await (await options.media()).getTask(parsed.taskId, signal), agent, parsed.taskId, current, { kind: 'task' }, sessionDirectory, signal)
          } catch (error) {
            return { kind: 'error', text: `查询任务 ${parsed.taskId} 失败：${errorMessage(error)}` }
          }
        default:
          break
      }

      const prompt = parsed.prompt.trim()
      if (prompt.length === 0) {
        return { kind: 'error', text: usage(config) }
      }
      const model = chooseImageModel(agent, parsed.model, config.imageDefaultModel)
      try {
        const client = await options.media()
        // Attachments are the edit reference, in the order the user submitted
        // them; they reach the provider as `input_image_urls`. Non-image files
        // cannot be edit references, so they are dropped with a note.
        const inputImages = imageBlocks.length === 0
          ? undefined
          : await resolveAttachmentInputs(options, imageBlocks, signal)
        // The command plane settles before the UI clears the composer's send
        // record, so awaiting the whole media task would keep the attachment and
        // the sent line on screen for minutes. Create the task now, return at
        // once, and deliver the picture from the background.
        const aspectRatio = parsed.aspectRatio ?? config.imageDefaultAspectRatio
        const created = await client.createTask({
          model,
          prompt,
          resolution: parsed.resolution ?? config.imageDefaultResolution,
          ...aspectRatio.length === 0 ? {} : { aspectRatio },
          ...inputImages === undefined ? {} : { inputImages },
          ...parsed.advanced ?? {},
        }, signal)
        const controller = new AbortController()
        ctx.effect(() => () => controller.abort())
        activeTasks.add(created.id)
        trackImageJob(watchImageTask({
          options,
          client,
          taskId: created.id,
          config,
          agent,
          prompt,
          model,
          context: { kind: 'generate', referenceCount: imageBlocks.length },
          sessionDirectory,
          signal: controller.signal,
        }))
        const submitted = `已提交图片任务 ${created.id}（${model}），完成后会自动放进对话；手动续查：/image task ${created.id}`
        return {
          kind: 'success',
          text: fileCount === 0 ? submitted : `${submitted}\n（已忽略 ${fileCount} 个非图片附件）`,
        }
      } catch (error) {
        return {
          kind: 'error',
          text: `${imageBlocks.length === 0 ? '生成' : '编辑'}失败（${model}）：${errorMessage(error)}`,
        }
      }
    },
  })
}

/**
 * Validate and inline the submitted images, preserving submission order.
 *
 * Uses the same gate as the native edit tool: format whitelist, one WebP pass
 * when decoded bytes exceed 5 MiB or a side exceeds 4096 px, and bilingual
 * errors. A failed image aborts the whole command.
 */
async function resolveAttachmentInputs(
  options: ImageCommandOptions,
  blocks: readonly ImageBlock[],
  signal: AbortSignal,
): Promise<string[]> {
  const store = options.attachments()
  if (store === undefined) {
    throw new Error('当前 Host 没有附件存储，无法读取本次提交的图片')
  }
  const urls = new Array<string>(blocks.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(INPUT_CONCURRENCY, blocks.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= blocks.length) return
      const stored = await store.readImage(blocks[index]!.attachment, signal)
      urls[index] = await prepareImageBytes(stored.data)
    }
  })
  await Promise.all(workers)
  return urls
}

/** Best-effort one-line error text for command results. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse the free-form input the command owns. */
function parseImageCommand(rawInput: string): Parsed {
  const tokens = rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
  const first = tokens[0]
  if (first === undefined || first === 'help' || first === '-h' || first === '--help') return { kind: 'help' }
  if (first === 'models') return { kind: 'models' }
  if (first === 'model') return { kind: 'model', ...tokens[1] === undefined ? {} : { model: tokens[1] } }
  if (first === 'task') return { kind: 'task', ...tokens[1] === undefined ? {} : { taskId: tokens[1] } }
  let model: string | undefined
  let resolution: string | undefined
  let aspectRatio: string | undefined
  let advanced: AdvancedImageParameters = {}
  const promptParts: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const flag = readFlag(token)
    if (flag !== undefined) {
      const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined
      const value = inline ?? tokens[index + 1]
      if (inline === undefined) index += 1
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'generate', prompt: `缺少 ${flag} 的取值：${token}` }
      }
      if (flag === '--model' || flag === '-m') model = value
      else if (flag === '--resolution' || flag === '-r') resolution = value
      else if (flag === '--ratio' || flag === '--aspect-ratio' || flag === '-a') aspectRatio = value
      else if (flag === '--quality') advanced = { ...advanced, quality: value }
      else if (flag === '--thinking-level') advanced = { ...advanced, thinkingLevel: value }
      else if (flag === '--background') advanced = { ...advanced, background: value }
      else if (flag === '--width') advanced = { ...advanced, width: Number(value) }
      else if (flag === '--height') advanced = { ...advanced, height: Number(value) }
      else if (flag === '--sequential') advanced = { ...advanced, sequentialImageGeneration: value }
      continue
    }
    promptParts.push(token)
  }
  return {
    kind: 'generate',
    prompt: promptParts.join(' '),
    ...model === undefined ? {} : { model },
    ...resolution === undefined ? {} : { resolution },
    ...aspectRatio === undefined ? {} : { aspectRatio },
    ...Object.keys(advanced).length === 0 ? {} : { advanced },
  }
}

/** Recognize one option flag, with or without `=value`. */
function readFlag(token: string): string | undefined {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
  return [
    '--model', '-m',
    '--resolution', '-r',
    '--ratio', '--aspect-ratio', '-a',
    '--quality',
    '--thinking-level',
    '--background',
    '--width',
    '--height',
    '--sequential',
  ].includes(name) ? name : undefined
}

/** Usage/help text for bare `/image`. */
function usage(config: ResolvedConfig): string {
  // An empty configured ratio means "no default": the provider picks it.
  const aspectRatio = config.imageDefaultAspectRatio.trim()
  return [
    'Mojie 图片生成：',
    '  /image <描述>                       用当前默认模型生成',
    '  /image <描述> + 附带图片            编辑/融合：图片按上传顺序作为参考图提交',
    '  /image <描述> --model flux2-pro     本次换模型（--resolution 2K、--ratio 16:9 同理）',
    '  /image <描述> --quality high        高级参数（模型特定，可组合）：',
    '      --thinking-level <minimal|low|medium|high>   --quality <auto|low|medium|high|max>',
    '      --background <auto|transparent|opaque>       --width <px> --height <px>',
    '      --sequential <disabled|auto>',
    '      每个高级参数只对文档列出的模型有效，传给其他模型会直接报错（不会白建任务）。',
    `      参数与适用模型：${IMAGE_PARAMETER_DOC_URL}`,
    '  /image models                       列出可用模型',
    '  /image model <id>                   切换默认模型（同时写入设置，等于设置页输入框）',
    '  /image model auto                   恢复内置默认',
    '  /image task <task_id>               续查超时返回的 processing 任务',
    '',
    `当前模型：${config.imageDefaultModel}｜分辨率 ${config.imageDefaultResolution}｜比例 ${aspectRatio.length === 0 ? '不限制' : aspectRatio}`,
    '也可以在「设置 → 模型 → Mojie」里用下拉建议或手动输入选择默认图片模型。',
  ].join('\n')
}

/** List models with the effective choice marked and their advanced parameters. */
async function describeModels(options: ImageCommandOptions, current: string, signal: AbortSignal) {
  const models = await (await options.media()).listModels(signal)
  if (models.length === 0) return '这个 API key 当前没有可用的图片模型。'
  const lines = models.map((model) => {
    const summary = advancedParameterSummary(model)
    return `${model === current ? '*' : ' '} ${model}${summary.length === 0 ? '' : ` — ${summary}`}`
  })
  return [`Mojie 图片模型（${models.length}，* 为当前默认）：`, ...lines, '', '切换：/image model <id>'].join('\n')
}

/** Read or persist the default image model through the settings surface. */
async function chooseModel(
  ctx: Context,
  options: ImageCommandOptions,
  agent: Agent,
  model: string | undefined,
  current: string,
  signal: AbortSignal,
) {
  if (model === undefined) {
    return { kind: 'success', text: `当前默认图片模型：${current}\n可用：/image models ｜ 切换：/image model <id> ｜ 恢复：/image model auto` } as const
  }
  const target = model === 'auto' ? DEFAULT_IMAGE_MODEL : model
  const models = await (await options.media()).listModels(signal)
  if (!models.includes(target)) {
    return {
      kind: 'error',
      text: `没有名为 "${target}" 的图片模型。可用模型：\n${models.join('\n')}`,
    } as const
  }
  const settings = ctx.get('settings') as SettingsForms | undefined
  if (settings === undefined) {
    return { kind: 'error', text: '当前 Host 没有提供设置服务，无法持久化默认模型；请改用 --model 逐次指定。' } as const
  }
  await settings.update(options.settingsNamespace, { imageDefaultModel: target })
  // The explicit change is the conversation's new choice. Record it under the
  // default that was in force before the write: the next call either sees the
  // updated default (memory is stale and the new default applies) or still sees
  // the old one (the remembered target applies). Both settle on the target.
  rememberImageModel(agent, target, current)
  return {
    kind: 'success',
    text: model === 'auto'
      ? `已恢复内置默认：${target}`
      : `默认图片模型已切换为 ${target}（已写入设置；设置页输入框同步显示）`,
  } as const
}

/**
 * Save every image of one settled task and steer the display copies into the
 * conversation.
 *
 * This is the command-side view of the same `storeTask` used by the native
 * tools: every image the provider returned is downloaded, the provider's exact
 * bytes go into the Session directory, a durable attachment becomes the display
 * copy, and the provider URL is always reported. When the directory or the
 * store is unavailable the URL is still steered, so the user can download the
 * picture; a successful result also always shows the URLs.
 */
async function deliverTask(
  options: ImageCommandOptions,
  task: MojieMediaTask,
  agent: Agent,
  label: string,
  model: string,
  context: ImageCommandContext,
  resolveDirectory: (agent: Agent, signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
  deliver: (message: Parameters<Agent['steer']>[0]) => void = (message) => agent.steer(message),
) {
  if (task.status === 'failed') {
    return { kind: 'error', text: `图片任务 ${task.id} 失败：${task.error ?? '上游未说明原因'}` } as const
  }
  if (task.images.length === 0) {
    return {
      kind: 'success',
      text: `任务 ${task.id} 仍是 ${task.status}；稍后用 /image task ${task.id} 续查。`,
    } as const
  }

  const value = await storeTask(task, {
    media: options.media,
    attachments: options.attachments,
    sessionDirectory: async (caller, callSignal) => {
      const directory = await resolveDirectory(caller as Agent, callSignal ?? signal)
      if (directory === undefined) throw new Error('the Session directory is unavailable')
      return directory
    },
  }, agent, signal)
  const envelope = taskText(value)
  const count = value.images?.length ?? 0
  const images: ContentBlock[] = []
  for (const image of value.images ?? []) {
    if (image.saved === undefined) continue
    images.push({ type: 'image', attachment: toImageRef(image.saved) })
  }
  // The command runs without a model turn, so this steered message is the
  // model's only view of what happened. State the command, whether it carried
  // references, and that the pictures are its output — otherwise the model may
  // mistake the result for a fresh user upload and keep editing the old one.
  const contextText = context.kind === 'task'
    ? '【/image task 命令】以下是对历史图片任务的查询结果，不是用户新上传的图片。'
    : context.referenceCount > 0
      ? `【/image 命令】用户本次执行了 /image，并附带了 ${context.referenceCount} 张参考图（已按上传顺序提交）。下面的图片是命令生成结果，不是用户上传的新图。`
      : '【/image 命令】用户本次执行了 /image，未附带参考图（纯文本生成）。下面的图片是命令生成结果，不是用户上传的新图。'
  const caption: ContentBlock = {
    type: 'text',
    text: `${contextText}\n（Mojie 已生成 ${count} 张图 · ${model}）\n${envelope}\n提示词：${label}`,
  }
  deliver(createUserMessage({ content: [...images, caption], source: { kind: 'user' } }))
  return {
    kind: 'success',
    text: `已生成 ${count} 张并放进对话（任务 ${task.id}）：\n${envelope}`,
  } as const
}

/** Inputs the background watcher needs after the command has settled. */
interface WatchImageTaskOptions {
  readonly options: ImageCommandOptions
  readonly client: MojieMediaClient
  readonly taskId: string
  readonly config: ResolvedConfig
  readonly agent: Agent
  readonly prompt: string
  readonly model: string
  readonly context: ImageCommandContext
  readonly sessionDirectory: (agent: Agent, signal: AbortSignal) => Promise<string | undefined>
  readonly signal: AbortSignal
}

/**
 * Poll one submitted media task and deliver it after the command has settled.
 *
 * The command returns as soon as the task exists, so the composer's send record
 * clears immediately; this watcher follows the provider and steers the finished
 * pictures (or the failure) into the conversation as a new user-role message.
 */
async function watchImageTask(args: WatchImageTaskOptions): Promise<void> {
  const deliver = (message: Parameters<Agent['steer']>[0]) => {
    const agent = args.agent as Agent & { followup?: (message: Parameters<Agent['steer']>[0]) => void }
    if (typeof agent.followup === 'function') agent.followup(message)
    else agent.steer(message)
  }
  try {
    const deadline = Date.now() + args.config.imageTaskTimeoutMs
    let task = await args.client.getTask(args.taskId, args.signal)
    while (task.status === 'pending' || task.status === 'processing') {
      if (Date.now() >= deadline) {
        throw new Error(`任务 ${args.taskId} 超时仍未完成，可稍后用 /image task ${args.taskId} 续查`)
      }
      await delay(args.config.imagePollIntervalMs, args.signal)
      task = await args.client.getTask(args.taskId, args.signal)
    }
    const result = await deliverTask(
      args.options,
      task,
      args.agent,
      args.prompt,
      args.model,
      args.context,
      args.sessionDirectory,
      args.signal,
      deliver,
    )
    if (result.kind === 'error') deliver(textMessage(result.text))
  } catch (error) {
    if (args.signal.aborted) return
    try {
      deliver(textMessage(`图片任务 ${args.taskId} 失败：${errorMessage(error)}`))
    } catch {
      // The Session may be gone; the task id remains available for /image task.
    }
  } finally {
    activeTasks.delete(args.taskId)
  }
}

/** Abortable timer used between task polls. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

