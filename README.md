# dsh-mojie-model-provider

独立的 **DeepSeek Harness (dsh) 插件**仓库：把 **mojieaigc.com** 的模型作为一条 dsh 模型 provider 路由（`mojie`）接入。

不依赖 deepseek-harness 源码树：本仓库只写插件自身，通过 npm 发布的 `@deepseek-ai/*` 包与官方运行时对接。**不修改任何 dsh 源码包**。

> [!IMPORTANT]
> 当前是**仓库骨架**：插件形态、配置 schema、测试与构建链路已就绪；适配器（adapter）本身尚未实现。

## 结构

```
dsh-mojie-model-provider/
  package.json        # 包清单；peer 依赖 @deepseek-ai/cordis、@deepseek-ai/dsh-llm
  tsconfig.json       # strict + ESM (NodeNext)，tsc 构建到 lib/
  src/index.ts        # 插件入口：name / inject / Config / apply
  tests/              # vitest 行为测试
  vitest.config.ts
```

`src/index.ts` 已落地的约定：

- **函数插件形态**：named-export `name`、`inject`、`Config`（Schemastery schema）、`apply(ctx, config)`，**无 default export**；
- **注册即效应**：provider 路由通过 `ctx.effect(() => ctx.llm.registerAdapter(...))` 注册，插件卸载时自动撤销；
- **无硬编码 tunable**：`apiKey` / `baseURL` / `models` / `requestTimeoutMs` 都是可在 `cordis.yml` 里改的 `Config` 字段。

## 待实现（唯一的接缝）

`src/index.ts` 的 `createAdapter(config)` 目前返回 `undefined`——填入 `MojieAdapter` 即完成接入：

1. `MojieAdapter extends LlmAdapter`，唯一必须实现的方法是 `stream(options): AsyncIterable<StreamChunk>`；
2. 请求侧把 `GenerateOptions`（`messages` / `system` / `tools` / `temperature` / `maxTokens` …）序列化为 `POST {baseURL}/chat/completions` 的 JSON body，并带 `Authorization: Bearer <apiKey>`；
3. 响应侧解析 SSE 帧，翻译成 `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish` 这一组 chunk；
4. 错误按稳定 code 分类（`AUTH` / `RATE_LIMIT` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `SERVER` / `TRANSPORT` …），抛 `LlmError` 或以 `finish { kind: 'error' | 'aborted' }` 收尾。

参考实现（harness 仓库内）：

- 适配器总览：`packages/llm/llm-deepseek/src/adapter.ts`
- SSE 解析 / 事件翻译：同目录 `sse.ts`、`translate.ts`
- 错误分类：同目录 `transport.ts`
- 官方教程：`docs/cookbook/adding-an-llm-adapter.md`

## 快速开始

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc -> lib/
pnpm test        # vitest run
```

要求 Node `^22.19 || >=24`（与 dsh 引擎范围一致）。

## 注册进 dsh（开发完成后）

```sh
# 发布后（或本地 linked）安装到 profile
dsh plugin add @dsh-dev/dsh-mojie-model-provider
```

然后在对应 profile 的 `cordis.patch.yml` 中挂载并配置：

```yaml
- plugin: '@dsh-dev/dsh-mojie-model-provider'
  config:
    apiKey: !!js process.env.MOJIE_API_KEY
    baseURL: 'https://mojieaigc.com/v1'
    models:
      - deepseek-v4-flash
      - gpt-5.5
```

> [!TIP]
> `apiKey` 不要写进配置文件：用 `!!js process.env.MOJIE_API_KEY` 从环境变量注入。

## 包规范要点

- ESM：`"type": "module"`，本地相对导入带 `.ts` 后缀，`exports` 指向 `lib`；
- `peerDependencies` 声明 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-llm`，与引擎共享单例；
- 函数插件**不要** default export（Loader 依赖 named-export 元数据）。
