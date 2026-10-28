<p align="center">
  <a href="https://mojieaigc.com"><img src="docs/assets/mojie-logo.png" alt="Mojie" width="112" /></a>
</p>

<h1 align="center">Mojie 模型插件</h1>

<p align="center">
  <a href="https://github.com/MoJIeAIGC">GitHub</a> ·
  <a href="https://space.bilibili.com/483532108">B站</a> ·
  <a href="https://www.douyin.com/user/MS4wLjABAAAA3JbjlCqKd8WXklSYmO64wxWeMBg4efViyTg8Gz6VZdI">抖音</a>
</p>

## 这是什么
由MojieAI开发的deepseek-harness插件，用于将Mojieaigc.com的所有平台能力无缝接入到DSH中，无需多余配置，直接让你的DSH拥有原生多模型，生图生视频能力。

| 用一个 Key，聊全球主流模型 | 一句话，让 AI 出图 | 像原生模型一样用 |
| :-- | :-- | :-- |
| GPT、Claude、Gemini、Qwen、DeepSeek、豆包、Kimi、Grok、GLM 等主流模型，全部出现在 DSH 的模型下拉里。 | `/image 一只戴帽子的猫` 直接把图画进对话；也可以对 AI 说「帮我画……」，它自己调用画图工具。 | 流式输出、工具调用、图片输入、上下文窗口，全部沿用 DSH 原生能力，聊天习惯不用改。 |

插件做三件事，并且只做这三件事：

- **接入模型** —— 把 Mojie 的 `/v1/models` 与聊天接口映射成一条 DSH provider 路由（`mojie`）；
- **接入画图** —— 提供 `/image` 斜杠命令和 4 个原生画图工具，结果图存进本机附件目录；
- **接入视频**(暂待更新) —— 提供 `/video` 斜杠命令和 原生视频工具，结果视频存进本机附件目录；
- **保管钥匙** —— API Key 走 DSH 的凭据服务或环境变量，不进插件配置，也不进对话内容。

---

## 快速开始

> 🚀 三步：装插件 → 填 Key → 开始聊天，全程不需要写代码。

### 第 0 步 · 准备三样东西

1. **DSH**：已经装好并能正常聊天，版本 `0.2.1-rc.2` 及以上（桌面版或命令行版都行）。
2. **Mojie 账号**：打开 <https://mojieaigc.com> 注册 / 登录。
3. **API Key**：登录后进入「个人中心」→「API-KEY」→ 点复制。

> [!TIP]
> 聊天按 token 计费、画图按张 / 分辨率计费，都从主站点数里扣。先确认余额，再开始玩。

> [!WARNING]
> 这串 Key 就是你的钥匙。不要发到群里、贴进截图，也不要提交到代码仓库。

### 第 1 步 · 安装插件

#### 方式 A · 插件市场（推荐）

1. 打开 DSH，进入 **设置**。
2. 找到 **插件 / 插件市场** 页面。
3. 搜索 **Mojie**（或包名 `@mojieai/dsh-mojie-model-provider`）。
4. 点 **安装**，等它自己装完。

#### 方式 B · 一行命令

打开终端（PowerShell / Terminal）：

```sh
dsh plugin --profile desktop add https://github.com/MoJIeAIGC/dsh-mojie-model-provider/releases/latest/download/mojieai-dsh-mojie-model-provider-0.0.0.tgz
```

> [!NOTE]
> URL 里的版本号要和发布页上的文件名一致。如果提示 404，请到 [Releases](https://github.com/MoJIeAIGC/dsh-mojie-model-provider/releases) 页面复制最新的 `.tgz` 链接替换。

#### 装完必须重启一次

新插件是在 DSH 启动时加载的，**不重启看不到效果**。

- **Windows 桌面版**：右键托盘图标 → **退出**（只关窗口不算退出），再双击 `DeepSeek Harness` 重新打开。
- **命令行版**：结束当前的 `dsh` 进程，重新启动。

### 第 2 步 · 填 API Key（一次就好）

1. 重启后进入 **设置 → 模型**。
2. 找到 **Mojie provider 设置** 卡片（初始显示「尚未配置凭据」）。
3. 在 **API Key** 输入框里粘贴第 0 步复制的 Key。
4. 点 **保存 Mojie 设置**，看到「已保存。」即可，以后不用再填。

> [!TIP]
> 不想在界面里填也行：启动 DSH 前把 Key 放进环境变量 `MOJIE_API_KEY`，效果完全一样。具体写法见 [设置项](#设置项)。

### 第 3 步 · 开始用

**聊天** —— 在 **设置 → 模型** 或聊天界面的模型下拉里，选一个 Mojie 提供的模型（例如 `claude-opus-5.5`、`gpt-6-astra`、`Kimi-k3.1-pro`），然后像平时一样发消息。它和原生模型一样支持：

- **工具调用**（读写文件、跑命令、搜索等）
- **看图**（把图片拖进输入框，选一个支持图片的模型）

**画图** —— 在输入框里敲：

```text
/image 一只戴帽子的猫，扁平插画风，白底
```

几秒到几十秒后，图片会直接出现在对话里，并附上模型名与尺寸。

---

## 画图手册

> 🎨 `/image` 是给人用的画图入口：提示词原样发给画图模型，不经过聊天模型改写，也不靠模型猜测要调哪个工具。

### 常用写法

| 想做什么 | 输入 |
| :-- | :-- |
| 画一张（用当前默认模型） | `/image 一只戴帽子的猫` |
| 本次换模型 | `/image 一只猫 --model mojie-nanobanana-2` |
| 指定分辨率与比例 | `/image 赛博朋克风的城市夜景 --resolution 2K --ratio 16:9` |
| 列出可用的画图模型 | `/image models` |
| 切换默认模型 | `/image model mojie-nanobanana-2` |
| 恢复内置默认 | `/image model auto` |
| 续查没跑完的任务 | `/image task <任务ID>` |
| 查看用法 | `/image help` |

参数可以简写：`--model`/`-m`、`--resolution`/`-r`、`--ratio`/`--aspect-ratio`/`-a`，也支持 `--model=mojie-nanobanana-2` 这种等号写法。

### 任务没跑完怎么办

图片生成是异步任务。等待超时时，命令会提示「任务 xxx 仍是 processing」，把这个 ID 交给 `/image task` 再查一次即可，**图不会丢**。

- 结果图会下载到本机附件目录，重启 DSH 后仍能在对话里看到。
- 想要多张，就多敲几次 `/image`，每张都会单独发进对话。

### 设置默认画图模型

1. **设置 → 模型 → Mojie provider 设置**
2. 找到 **图片生成默认模型** 下拉框；列表为空就点右侧 **刷新图片模型**。
3. 选一个（例如 `flux2-pro`、`mojie-image-2`），点 **保存 Mojie 设置**。

之后 `/image …` 和 AI 自己画图都会用这个模型。也可以随时用 `/image model <模型名>` 切换——两处改的是同一个设置。

> [!NOTE]
> 内置默认是 `seedream-5-image`，分辨率 `1K`、比例 `1:1`。想改默认分辨率与比例，见 [设置项](#设置项) 里的进阶字段。

### 让 AI 自己画 / 改图

插件注册了 4 个原生工具，AI 会在需要时自己调用：

| 工具 | 用途 |
| :-- | :-- |
| `mojie_generate_image` | 文字生图，可指定模型、分辨率、比例 |
| `mojie_edit_image` | 改图 / 重绘，输入图支持 URL、`data:` URL 或本地文件路径 |
| `mojie_list_image_models` | 列出当前 Key 可用的画图模型 |
| `mojie_image_task` | 查询任务状态，完成后把图取回对话 |

- **画**：直接说「帮我画一张……」即可，AI 会把图画进对话。
- **改**：把图片拖进输入框，说「把这张图的背景换成沙滩」「改成蓝色电影色调」，AI 会把结果图发回来。

---

## 模型清单

> 🧠 一个 Key，主流模型。上下文窗口、输出上限、图片输入能力由 `/v1/models` 实时发现，并以内置快照兜底。

<details>
<summary><b>OpenAI · GPT</b>（11）</summary>

`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6-luna`、`gpt-6-astra`、`gpt-5.6-terra-pro`、`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-5.6-luna-pro`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`

</details>

<details>
<summary><b>Anthropic · Claude</b>（14）</summary>

`claude-opus-5.5`、`claude-sonnet-5.5`、`claude-haiku-5.5`、`claude-opus-5`、`claude-sonnet-5`、`claude-fable-5.1`、`claude-fable-5`、`claude-opus-4.8`、`claude-opus-4.7`、`claude-sonnet-4.6`、`claude-opus-4.6`、`claude-sonnet-4.5`、`claude-opus-4.5`、`claude-haiku-4.5`

</details>

<details>
<summary><b>Google · Gemini</b>（9）</summary>

`gemini-4-argon`、`gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-pro-preview`、`gemini-3.1-flash-lite`、`gemini-3-flash-preview`

</details>

<details>
<summary><b>阿里 · Qwen</b>（8）</summary>

`qwen3.8-max`、`qwen3.8-omni-flash`、`qwen3.8-flash`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`

</details>

<details>
<summary><b>字节 · 豆包</b>（7）</summary>

`doubao-seed-2-1-pro`、`doubao-seed-2-1-turbo`、`doubao-seed-2-1-lite`、`doubao-seed-2-0-lite`、`doubao-seed-2-0-mini`、`doubao-seed-2-0-code-preview`、`doubao-seed-character`

</details>

<details>
<summary><b>智谱 · GLM</b>（6）</summary>

`GLM-5.3`、`GLM-5.3-FlashX`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5.1`、`GLM-5`

</details>

<details>
<summary><b>Moonshot · Kimi</b>（4）</summary>

`kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.7-code`

</details>

<details>
<summary><b>xAI · Grok</b>（4）</summary>

`grok-4.7`、`grok-4.6`、`grok-4.5`、`grok-4.3`

</details>

<details>
<summary><b>DeepSeek</b>（2）</summary>

`deepseek-v4-pro`、`deepseek-v4-flash`

</details>

> [!NOTE]
> 清单会随主站更新。设置卡片里的 **刷新模型列表** 会把新模型合并进 `models`；也可以在 `models` 里手写条目，钉住你需要的模型和能力声明。内置快照见 [`src/catalog.generated.ts`](src/catalog.generated.ts)，可用 `pnpm sync:catalog` 刷新。

---

## 设置项

界面上的字段都在 **设置 → 模型 → Mojie provider 设置** 里：

| 界面上的叫法 | 配置字段 | 默认值 |
| :-- | :-- | :-- |
| API Key | 凭据 `MOJIE_API_KEY` | 空（必填） |
| 凭据引用 | `apiKeyEnv` | `MOJIE_API_KEY` |
| Base URL | `baseURL` | `https://mojieaigc.com` |
| 模型列表 | `models` | 空（自动发现 + 内置快照） |
| 图片生成默认模型 | `imageDefaultModel` | `seedream-5-image` |

Base URL 会自动填写 `https://mojieaigc.com`；
带 `www.` 或带 `/v1` 后缀都能识别，多余的路径会被去掉。

想用环境变量代替界面填 Key（PowerShell，设置后重开 DSH）：

```powershell
[Environment]::SetEnvironmentVariable('MOJIE_API_KEY','你的 Mojie API Key','User')
```

## 常见问题

<details>
<summary><b>设置里模型列表是空的？</b></summary>

先确认 API Key 已保存（卡片上会显示「已配置凭据」），再点 **刷新模型列表**；画图模型则点 **刷新图片模型**。如果仍然为空，检查主站余额是否用完，或 Base URL 是否被改错。

</details>

<details>
<summary><b>画图报 AUTH / 401？</b></summary>

Key 复制错了或已失效。回主站「个人中心 → API-KEY」重新复制一次，粘进卡片保存即可。注意别把首尾空格一起粘进去。

</details>

<details>
<summary><b>提示 RATE_LIMIT / 上游繁忙？</b></summary>

主站临时限流，等几十秒再试。画图失败通常不会产生可用的创作结果，可以直接重发。

</details>

<details>
<summary><b>/image 命令打不出来？</b></summary>

按顺序自查：

1. 插件已安装，并且**重启过** DSH；
2. 设置 → 模型里能看到「Mojie provider 设置」卡片；
3. 在输入框敲 `/`，菜单里能看到 **image**。

</details>

<details>
<summary><b>怎么升级插件？</b></summary>

在插件市场点更新；或先卸载再装新版 tarball，然后重启。。

</details>

<details>
<summary><b>怎么卸载？</b></summary>

在插件市场点卸载，或执行：

```sh
dsh plugin --profile desktop remove "@mojieai/dsh-mojie-model-provider"
```

然后重启 DSH。已生成的图片仍然保存在本机附件目录里，不会被删掉。

</details>

<details>
<summary><b>费用怎么算？</b></summary>

由 Mojie 主站按点数计费（聊天按 token、画图按张 / 分辨率），DSH 这边不额外收费。具体价格见主站。
余额不足请前往[Mojieaigc.com](https://www.mojieaigc.com) 充值

</details>

---

## 隐私与安全

- **Key 只在本机**：保存在 DSH 的凭据存储里（或 `MOJIE_API_KEY` 环境变量），不写进插件配置，也不进入对话内容。
- **请求直连主站**：聊天与画图请求直接发往 `mojieaigc.com`，不经过第三方中转。
- **图片留在本地**：生成结果下载到本机附件目录，方便之后继续查看或二次编辑。
- **别把 Key 贴出去**：不要贴进对话、截图或代码仓库；怀疑泄露时，去主站重置 Key 再改一遍设置。

---


遇到问题或想提需求，欢迎到 [MojieAgentflow](https://www.mojieaigc.com) 留言，附上 DSH 版本、操作系统和报错原文会更好排查。账号、余额、Key 相关的问题，请找 Mojie 主站客服。

