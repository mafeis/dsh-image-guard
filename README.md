# dsh-image-guard

DeepSeek Harness（DSH）插件，用于保证含图会话可继续使用：在请求发送前将历史图片裁剪至预算内；上游仍因图片数量返回 400 时，插件从该错误中解析上限，并按更少的图片降级重试。

[English](README.en.md) · MIT · v0.8.17 · [变更记录](CHANGELOG.md)

## 主要特性

- **保留最新 N 张，其余替换为标记**——被裁剪的图片会替换为可识别标记（文件名 / 路径 / 指纹 / 取回方式），模型或 agent 需要时可再次取得该图，而不是无声丢失。
- **解析上游上限**——从 `At most N image(s) may be provided in one prompt` 中解析上限 N，并按 N−1 张重试；解析到上限后，同进程内后续请求直接按 N−1 张发送。
- **节省视觉 token**——每张被裁剪的图片净省约 930 token（实测上限 972 − 标记开销约 40）；14 张裁剪至 7 张约每轮省 6.5k token，设置页实时显示累计节省量。
- **不修改会话历史**——仅修改即将发出的请求体（`structuredClone` 的副本），前缀缓存保持有效，关闭插件即恢复原有行为。
- **始终保持在 fetch 链首**——拦下 `globalThis.fetch` 的赋值（新来的包装器收作下层、照旧生效），配合 200ms 看门狗与链上探针兜底，避免 `dsh-net-proxy` 在走代理时绕过它。

## 安装

> **注意**：本插件目前尚未发布到 npm，也未被任何插件市场目录（dshfind、1024Store、awesome-dsh-plugin）收录，因此在 DSH Desktop 的 GUI 插件市场中搜索不到。收录进展见文末「市场收录」。桌面端请先使用下方的手动安装。

### DSH Desktop（手动安装）

DSH Desktop 加载名为 `desktop` 的 profile，位于 `~/.dsh/profiles/desktop/`（Windows 即 `%USERPROFILE%\.dsh\profiles\desktop\`）。该 profile 由 Electron 持有，`dsh plugin` 命令会被启动器拒绝，安装需手动编辑 manifest：

1. 编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 中加入：

   ```json
   "dsh-image-guard": "github:mafeis/dsh-image-guard"
   ```

2. 在同一文件的 `dsh.profile.bundles` 数组中追加 `"dsh-image-guard"`（该字段不存在则在 `dsh` 字段下新建）：

   ```json
   "dsh": {
     "profile": {
       "bundles": ["dsh-image-guard"]
     }
   }
   ```

3. 安装依赖后重启 DSH Desktop：

   ```sh
   cd ~/.dsh/profiles/desktop && pnpm install --prefer-offline --ignore-scripts
   ```

GUI（设置 → 插件）只识别上述两处——`dependencies` 与 `dsh.profile.bundles`；手工在 `cordis.patch.yml` 中添加 `insert` 条目不会加载插件。Desktop 自带的 pnpm 以 Electron runtime 执行安装，手动 `pnpm install` 对纯 JS 插件（本插件无任何依赖）结果一致。

### 命令行 profile

`dsh plugin --profile <name> add github:mafeis/dsh-image-guard`

注意：`desktop` 不在此列——它是 Electron 持有的 profile 名称，启动器拒绝对其执行插件管理请求。

### 市场收录

待办事项（完成后 GUI 市场即可一键安装）：

- 发布 npm 包 `dsh-image-guard`——内置市场目录（dshfind / 1024Store）只索引 npm 包，Desktop 的市场安装通道也只接受精确的 npm 包名；
- 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 添加 `data/plugins/mafeis__dsh-image-guard.yml`（该列表驱动 dsh-market 市场）。

## 验证

1. 设置 → 图片守卫 → 诊断：应显示守卫已接入 fetch 链，且链上探针计数持续增加。
2. `~/.dsh/image-guard-status.json`：`chatPosts` 开始增长。
3. 如需先观察再启用，在设置页打开 `dryRun`——它只记录将被裁剪的图片，不修改任何请求。

## 工作原理

```
DSH agent
   │  POST /v1/chat/completions          image_url: data:image/png;base64,…
   ▼
┌─────────────── fetch 链 ──────────────────┐
│  image-guard       ← 裁剪、解析上限、重试  │  必须位于此层
│       ▼                                   │
│  dsh-net-proxy     ← 走代理时绕过其下层    │
└───────────────────────────────────────────┘
   ▼
上游推理服务
```

仅处理「`POST` + 匹配聊天补全路径 + 请求体含图片」的请求，其余请求原样透传。保留最新 `keepRecent` 张图片，其余替换为标记，并以 `structuredClone` 后的请求体发送。收到 `At most N image(s)` 时解析上限 N，按 N−1 张重试，最多 `maxRetries` 次。

为何需要按张数控制：`--limit-mm-per-prompt.image` 按**整个 prompt** 计数，而 DSH 客户端的预算按字节 / 像素计算、不限制张数——因此字节预算无法阻止该失败，compact 压缩也不起作用（它重发同一份历史）。为何需要接管链首：走代理时 `dsh-net-proxy` 使用自带 socket 发包，会绕过其下层的一切 fetch 包装器，且其「跟随系统代理」模式会在系统代理每次变更时把自身重新安装到链首——此时它既不会调用下层，也就无法靠事后抢回消除窗口。因此本插件拦下 `globalThis.fetch` 的赋值：新来的包装器被收作下层（它照旧生效），本插件始终位于最上层；被整个替换掉属性时由 200ms 看门狗与链上探针兜底抢回。

## 被裁剪图片的替换内容

| 场景 | 标记 |
|---|---|
| 有路径（常态，默认仅文件名） | `[图片已省略 #1 · 01-race-start.png · 需要时按文件名在工作区内搜索后读取]` |
| `pathMode=full` | `[图片已省略 #1 · C:\path\to\shots\01-race-start.png · 需要时用 read_image 重新读取]` |
| 仅有附件元数据 | `[图片已省略 #1 · 01-race-start.png · 内联图片 sha256:bf23bcd3 (image/png 1280x720 618 KiB) · 无原文件路径，已无法取回]` |
| 远端 URL | `[图片已省略 #1 · race.png · https://…/race.png · 需要时可重新访问该地址]` |

标识来源顺序：相邻文本片段中的 `<path>` / 文件名 / 尺寸 / 字节 → 远端 URL → 内联数据的 **sha1 指纹**（「前 4 KB + 总长」，同一张图的标识稳定）。无法取回时标记会明确说明，而非让模型自行推测。

模板（`placeholder`）支持 `{index} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}`。`{total}` 与 `{kept}` 随会话增长而变化，会使被裁剪位置之后的**前缀缓存失效**，因此默认不使用。

标记语言由 `markerLang` 决定，共三态：**留空（默认）= 跟随应用界面语言**（英文界面出英文标记，中文界面出中文标记）、`zh`、`en`。`placeholder` 若留空、或写的正好是某语言的默认模板（视为未自定义），即使用生效语言的默认模板。语言不只换默认模板，也换标记正文里的身份标签与取回提示（`需要时用 read_image 重新读取` ↔ `read it again with read_image`），因此固定 `en` 后整条标记不含中文。设置页「参数」的**标记语言**下拉即这三态，切换时会把仍是默认值的模板一起换掉，自定义模板保持不动。

标记会随请求发送至上游，因此默认 `pathMode: "basename"` 仅写入文件名——目录结构与盘符保留在本机（`relative` 使用相对工作区或 `~` 的路径；`none` 连文件名也不写）。

## 配置

`~/.dsh/image-guard.json`，修改后热更新、无需重启；也可在设置页或通过 `/_dsh/image-guard` 路由修改。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后完全透传 |
| `keepRecent` | `12` | 保留最新的图片张数，其余替换为标记（`0` 表示全部） |
| `maxRetries` | `3` | 400 后的降级重试次数 |
| `learnLimit` | `true` | 是否从 400 响应中解析上游上限 |
| `dryRun` | `false` | 仅观察，不修改任何请求 |
| `matchPath` | `/chat/completions\|/messages` | 处理的路径（正则） |
| `markerLang` | 空（跟随界面语言） | 标记语言：留空跟随宿主界面语言，`zh` / `en` 为固定值；决定**默认模板**与标记正文（身份、取回提示）的语言 |
| `placeholder` | 空 | 标记模板；留空或等于某语言默认模板 = 用生效语言的默认模板（`zh` → `[图片已省略 #{index}{identity}{hint}]`，`en` → `[image omitted #{index}{identity}{hint}]`） |
| `pathMode` | `basename` | `full` / `relative` / `basename` / `none` |
| `tokensPerImage` | `972` | 估算节省量所用的单张图片视觉 token 数（`0` 表示不估算） |
| `verbose` | `true` | 是否输出日志 |

插件在本机只读三处文件：配置 `~/.dsh/image-guard.json`、状态 `~/.dsh/image-guard-status.json`，以及宿主 `~/.dsh/settings.yaml` 中的 `locale.preference`（**仅**用于决定默认标记语言，读不到即按中文）。除此之外不发起任何外发请求，凭据不读取、不上报。

## 状态与路由

`~/.dsh/image-guard-status.json` 包含 `chatPosts`、`bundled`、`trimmed`、`imagesDropped`、`retried`、`learnedLimit`、`maxSeen`、`tokensSaved`，以及 `fetchOwned` / `probes` / `probeSeen`（探针数为 0 表示未接入链）、`rewraps` / `stolenSeen` / `headName`（链首被占用与抢回的次数、当前链首）与 `diag`（最近 40 条请求形态：`input`、`body`、`bytes`、`imgs`、`msgs`——请求未被拦截时首先查看此处）。`GET` / `PUT /_dsh/image-guard` 读写配置，`POST ?reset=1` 恢复默认，`POST ?rewrap=1` 强制重新接入。

## 已知限制

| 限制 | 说明 |
|---|---|
| 仅控制**图片张数** | 不压缩、不缩放图片；字节预算不在处理范围 |
| 首次仍会出现一次 400 | 上限只能从 400 响应中获知 |
| 仅针对历史图片 | 最新 N 张按原样发送（含字节） |
| 与其他 fetch 包装插件的顺序 | 本插件固定在最上层、对方位于其下层：两者都生效，代价是直连模式下请求多穿一层包装 |
| 靠赋值抢占链首的插件会被拦下 | 它不会通过读取 `globalThis.fetch` 发现自己未在链首；若它整个替换该属性，200ms 内会被抢回（期间该插件仍会被调用） |
| 已内联且无路径的图片无法恢复 | 标记中携带指纹并明确说明 |
| 依赖 DSH 当前的请求形态 | 形态不匹配的请求会透传（诊断页可见） |

## 许可

[MIT](LICENSE) © mafeis
