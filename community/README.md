# 提交到 DSH 社区目录

DSH 插件市场（`dshmarket`）本身不存插件列表，它每次打开都实时拉
`https://dshmarket.com/index.json`，而那份索引由
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
仓库的 `data/plugins/*.yml`（一个插件一个文件）生成。
所以「上社区」= 往那个仓库提一个只加一条条目的 PR。

`dsh.so`（提交页）和 `dsh-plugin.org`（Hub）是另外两个入口，各自独立，
不依赖这个 PR。

## 本目录内容

| 文件 | 用途 |
|---|---|
| `MoJIeAIGC__dsh-mojie-model-provider.yml` | 待提交的目录条目，原样放进 `data/plugins/` |

截图已在 `assets/screenshots/`，清单在**仓库根目录** `screenshots.json`（已就绪，不属于本目录）。

本目录不参与 npm 打包（`package.json` 的 `files` 只含 `lib` / `docs` / `cordis.patch.yml`）。

## 提交顺序（重要）

1. **先提交并 push 本仓库**：`assets/icon-512.png` 必须已经在 `main` 上，
   否则条目里的 `icon` URL 会 404，市场卡片退回作者头像。
2. **再向 awesome-dsh-plugin 提 PR**。

## 提 PR（GitHub 网页操作，不需要本地 git）

1. fork [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；
2. 在 fork 里新建文件 `data/plugins/MoJIeAIGC__dsh-mojie-model-provider.yml`，
   内容照抄 `MoJIeAIGC__dsh-mojie-model-provider.yml`；
3. 提交到新分支（例如 `market-entry`）；
4. 向 `awesome-dsh-plugin:main` 发起 PR。**只加这一个文件**。

> 本机 git 的 `http.proxy` / `https.proxy` 指向 `127.0.0.1:59083`，该代理未运行时
> `git push` / `git ls-remote` 会失败；要么恢复代理，要么
> `git config --unset http.proxy; git config --unset https.proxy`。
> 用网页提 PR 可以绕开这个问题。

### PR 标题

```
Add MoJIeAIGC/dsh-mojie-model-provider (model)
```

### PR 正文（可直接粘贴）

```markdown
Adds one entry for `@mojieai/dsh-mojie-model-provider@0.2.2`.

- `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`; the repo
  contains the TypeScript source, not only a client manifest.
- Installs from the prebuilt v0.2.2 tarball (`tarball:`): `lib/` is build
  output and is not committed, so installing from source would ship no JS.
- The bundle mounts a model-provider row under the `mojie` settings namespace
  and registers four image tools (`mojie_generate_image`, `mojie_edit_image`,
  `mojie_list_image_models`, `mojie_image_task`) plus the `/image` command.
  The entry description claims nothing beyond that.
- Icon is a 512×512 PNG hosted in the repo.
- Screenshots are declared through `screenshots.json` in the repo root; all six
  are committed under `assets/screenshots/`.
```

## CI 会检查的项与当前状态

| 检查 | 要求 | 我们的情况 |
|---|---|---|
| 条目数量 | 每个 PR ≤ 3 条 | 1 条 |
| `dsh.bundle` | 仓库根 `package.json` 必须声明 | ✅ `./cordis.patch.yml` |
| 仓库年龄 | ≥ 1 天 | ✅ 2026-10-20 创建 |
| `dsh-plugin` topic | 仓库需带 | ✅ |
| 描述与代码一致 | 维护者会读源码核对每个数字/命令 | YAML 只写「模型下拉 + 图片工具 + `/image`」；README 已删掉「生视频」「所有平台能力」 |
| 图片托管 | 只收 GitHub 托管的位图；第三方图床拒绝 | icon 在仓库 `assets/`；截图需入库（见下） |
| `awesome-lint` | 双语一致性、分隔符、日期、截图 | 结束后跑一遍 |

## 合并后验证

1. `https://awesome-dsh-plugin.com/p/MoJIeAIGC/dsh-mojie-model-provider/` 能打开，
   标题、图标、截图正常。
2. `https://dshmarket.com/index.json` 里能搜到 `@mojieai/dsh-mojie-model-provider`
   （构建约在合并后一天刷新）。
3. 干净 profile：设置 → 插件 → 发现 → 搜 `Mojie` → 卡片显示 0.2.2 → 安装 →
   **重启** → 设置 → 模型 出现 Mojie 行 → 填 Key → `/image` 出图。
4. 抽查条目描述与代码一致。

## 截图（已就绪，不需要 PR）

- 6 张截图在 `assets/screenshots/`，README 已改用相对路径引用，根目录 `screenshots.json`
  声明了轮播顺序；push 后市场/站点下一次构建自动读取。
- 想补更贴 0.2.2 卖点的图（设置行 / `/image` 结果 / `/image models`），
  见 `assets/screenshots/README.md`，把新文件加进 `screenshots.json` 即可（≤ 8 张）。

## 后续维护

- **每个新版本**都要改条目里的 `tarball`（一行改动，开个小 PR）。资产名带版本号，
  所以不能固定写成 `releases/latest/download/...`——下一次发版就会 404。
- 能力有增减时同步改 `description`，并更新截图。
- 条目一旦不再维护（仓库归档/长期不动），会被定期扫描移出列表。
