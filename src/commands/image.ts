import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { createUserMessage, type ContentBlock, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_IMAGE_MODEL, type ResolvedConfig } from '../config.js'
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
  }

/**
 * Register `/image` on the calling context's `ctx.commands`.
 * @param ctx - context carrying the `commands` service.
 * @param options - configuration, media-client factory, attachments, settings namespace.
 */
export function registerImageCommand(ctx: Context, options: ImageCommandOptions): void {
  const commands: CommandRuntime = ctx.commands
  commands.register({
    name: IMAGE_COMMAND_NAME,
    // Host commands get no icon slot from the current client (its glyph table is
    // first-party only), so the pictogram rides the description line instead.
    description: '🖼 用 Mojie 生成图片（可直接指定模型；结果放进对话）',
    input: {
      hint: '<描述> [--model <id>] [--resolution 1K] [--ratio 1:1] | models | model [<id>] | task <id>',
    },
    async handler({ agent, rawInput, signal }) {
      const parsed = parseImageCommand(rawInput)
      const config = options.config()
      const current = config.imageDefaultModel

      switch (parsed.kind) {
        case 'help':
          return { kind: 'success', text: usage(config) }
        case 'models':
          return { kind: 'success', text: await describeModels(options, current, signal) }
        case 'model':
          return await chooseModel(ctx, options, parsed.model, current, signal)
        case 'task':
          if (parsed.taskId === undefined) {
            return { kind: 'error', text: '用法：/image task <task_id>（task_id 来自超时返回的 processing 任务）' }
          }
          try {
            return await deliverTask(options, await (await options.media()).getTask(parsed.taskId, signal), agent, parsed.taskId, current)
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
      const model = parsed.model ?? config.imageDefaultModel
      try {
        const client = await options.media()
        const task = await client.generate({
          model,
          prompt,
          resolution: parsed.resolution ?? config.imageDefaultResolution,
          aspectRatio: parsed.aspectRatio ?? config.imageDefaultAspectRatio,
        }, signal)
        return await deliverTask(options, task, agent, prompt, model)
      } catch (error) {
        return { kind: 'error', text: `生成失败（${model}）：${errorMessage(error)}` }
      }
    },
  })
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
  }
}

/** Recognize one option flag, with or without `=value`. */
function readFlag(token: string): string | undefined {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
  return ['--model', '-m', '--resolution', '-r', '--ratio', '--aspect-ratio', '-a'].includes(name) ? name : undefined
}

/** Usage/help text for bare `/image`. */
function usage(config: ResolvedConfig): string {
  return [
    'Mojie 图片生成：',
    '  /image <描述>                       用当前默认模型生成',
    '  /image <描述> --model flux2-pro     本次换模型（--resolution 2K、--ratio 16:9 同理）',
    '  /image models                       列出可用模型',
    '  /image model <id>                   切换默认模型（同时写入设置，等于设置页下拉）',
    '  /image model auto                   恢复内置默认',
    '  /image task <task_id>               续查超时返回的 processing 任务',
    '',
    `当前模型：${config.imageDefaultModel}｜分辨率 ${config.imageDefaultResolution}｜比例 ${config.imageDefaultAspectRatio}`,
    '也可以在「设置 → 模型 → Mojie」里用下拉框选择默认图片模型。',
  ].join('\n')
}

/** List models with the effective choice marked. */
async function describeModels(options: ImageCommandOptions, current: string, signal: AbortSignal) {
  const models = await (await options.media()).listModels(signal)
  if (models.length === 0) return '这个 API key 当前没有可用的图片模型。'
  const lines = models.map((model) => `${model === current ? '*' : ' '} ${model}`)
  return [`Mojie 图片模型（${models.length}，* 为当前默认）：`, ...lines, '', '切换：/image model <id>'].join('\n')
}

/** Read or persist the default image model through the settings surface. */
async function chooseModel(
  ctx: Context,
  options: ImageCommandOptions,
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
  return {
    kind: 'success',
    text: model === 'auto'
      ? `已恢复内置默认：${target}`
      : `默认图片模型已切换为 ${target}（已写入设置；设置页下拉同步显示）`,
  } as const
}

/**
 * Store the finished picture and put it into the conversation.
 *
 * The picture is saved into the durable attachment store and steered as an
 * image message, so it renders immediately, survives a restart, and is what the
 * model sees on its next step.
 */
async function deliverTask(
  options: ImageCommandOptions,
  task: MojieMediaTask,
  agent: Agent,
  label: string,
  model: string,
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

  const first = task.images[0]!
  const attachments = options.attachments()
  if (attachments === undefined) {
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: `Mojie 生成了图片（${model}）：${first.url}` }],
      source: { kind: 'user' },
    }))
    return { kind: 'success', text: `已生成（无附件存储，已把链接放进对话）：${first.url}` } as const
  }

  const client = await options.media()
  const { data, mediaType } = await client.download(first)
  const ref = await attachments.saveImage({ data, mediaType, name: `mojie-${task.id}` })
  const imageBlock: ImageBlock = { type: 'image', attachment: ref }
  const caption: ContentBlock = {
    type: 'text',
    text: `（Mojie 已生成这张图 · ${model} · ${ref.width}x${ref.height}px）\n提示词：${label}`,
  }
  agent.steer(createUserMessage({ content: [imageBlock, caption], source: { kind: 'user' } }))
  return {
    kind: 'success',
    text: `已生成并放进对话：${ref.width}x${ref.height}px · ${model} · 任务 ${task.id}`,
  } as const
}
