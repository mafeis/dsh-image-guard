# dsh-image-guard

DeepSeek Harness（DSH）插件，用于保证含图会话可继续使用：在请求发送前将历史图片裁剪至预算内；上游仍因图片数量返回 400 时，插件从该错误中解析上限，并按更少的图片降级重试。

[English](README.en.md) · MIT · v0.8.9 · [变更记录](CHANGELOG.md)

## 主要特性

- **保留最新 N 张，其余替换为标记**——被裁剪的图片会替换为可识别标记（文件名 / 路径 / 指纹 / 取回方式），模型或 agent 需要时可再次取得该图，而不是无声丢失。
- **解析上游上限**——从 `At most N image(s) may be provided in one prompt` 中解析上限 N，并按 N−1 张重试；解析到上限后，同进程内后续请求直接按 N−1 张发送。
- **节省视觉 token**——每张被裁剪的图片净省约 930 token（实测上限 972 − 标记开销约 40）；14 张裁剪至 7 张约每轮省 6.5k token，设置页实时显示累计节省量。
- **不修改会话历史**——仅修改即将发出的请求体（`structuredClone` 的副本），前缀缓存保持有效，关闭插件即恢复原有行为。
- **保持在 fetch 链首层**——1 秒看门狗配合链上探针重新接入包装器，避免 `dsh-net-proxy` 在走代理时绕过它。

## 安装

DSH Desktop：建议通过 GUI 插件市场安装。手动安装时，需注意 DSH Desktop 加载的是 `desktop` profile：

```sh
# 编辑 <DSH_HOME>/profiles/desktop/package.json
#   dependencies         "dsh-image-guard": "github:mafeis/dsh-image-guard"
#   dsh.profile.bundles  "dsh-image-guard"
cd <DSH_HOME>/profiles/desktop && pnpm install --prefer-offline --ignore-scripts
```

命令行 profile：`dsh plugin --profile <name> add github:mafeis/dsh-image-guard`

安装后需重启 DSH Desktop。注意：`desktop` 为 Electron 持有的 profile 名称，启动器会拒绝对其执行插件管理请求；此外，手工在 `cordis.patch.yml` 中添加 `insert` 条目不会加载插件——GUI 仅识别 `dependencies` 与 `dsh.profile.bundles`。

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

为何需要按张数控制：`--limit-mm-per-prompt.image` 按**整个 prompt** 计数，而 DSH 客户端的预算按字节 / 像素计算、不限制张数——因此字节预算无法阻止该失败，compact 压缩也不起作用（它重发同一份历史）。为何需要看门狗：走代理时 `dsh-net-proxy` 使用自带 socket 发包，会绕过其下层的一切 fetch 包装器，且其「跟随系统代理」模式会在系统代理变更时将其自身重新安装到链首；1 秒看门狗配合链上探针使本插件始终位于最上层，最多重新接入 5 次。

## 被裁剪图片的替换内容

| 场景 | 标记 |
|---|---|
| 有路径（常态，默认仅文件名） | `[图片已省略 #1 · 01-race-start.png · 需要时按文件名在工作区内搜索后读取]` |
| `pathMode=full` | `[图片已省略 #1 · C:\path\to\shots\01-race-start.png · 需要时用 read_image 重新读取]` |
| 仅有附件元数据 | `[图片已省略 #1 · 01-race-start.png · 内联图片 sha256:bf23bcd3 (image/png 1280x720 618 KiB) · 无原文件路径，已无法取回]` |
| 远端 URL | `[图片已省略 #1 · race.png · https://…/race.png · 需要时可重新访问该地址]` |

标识来源顺序：相邻文本片段中的 `<path>` / 文件名 / 尺寸 / 字节 → 远端 URL → 内联数据的 **sha1 指纹**（「前 4 KB + 总长」，同一张图的标识稳定）。无法取回时标记会明确说明，而非让模型自行推测。

模板（`placeholder`）支持 `{index} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}`。`{total}` 与 `{kept}` 随会话增长而变化，会使被裁剪位置之后的**前缀缓存失效**，因此默认不使用。

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
| `placeholder` | `[图片已省略 #{index}{identity}{hint}]` | 标记模板 |
| `pathMode` | `basename` | `full` / `relative` / `basename` / `none` |
| `tokensPerImage` | `972` | 估算节省量所用的单张图片视觉 token 数（`0` 表示不估算） |
| `verbose` | `true` | 是否输出日志 |

## 状态与路由

`~/.dsh/image-guard-status.json` 包含 `chatPosts`、`bundled`、`trimmed`、`imagesDropped`、`retried`、`learnedLimit`、`maxSeen`、`tokensSaved`，以及 `fetchOwned` / `probes` / `probeSeen`（探针数为 0 表示未接入链）与 `diag`（最近 40 条请求形态：`input`、`body`、`bytes`、`imgs`、`msgs`——请求未被拦截时首先查看此处）。`GET` / `PUT /_dsh/image-guard` 读写配置，`POST ?reset=1` 恢复默认，`POST ?rewrap=1` 强制重新接入。

## 已知限制

| 限制 | 说明 |
|---|---|
| 仅控制**图片张数** | 不压缩、不缩放图片；字节预算不在处理范围 |
| 首次仍会出现一次 400 | 上限只能从 400 响应中获知 |
| 仅针对历史图片 | 最新 N 张按原样发送（含字节） |
| 看门狗最多重新接入 5 次 | 避免包装器相互嵌套；超出后在诊断页标记 |
| 已内联且无路径的图片无法恢复 | 标记中携带指纹并明确说明 |
| 依赖 DSH 当前的请求形态 | 形态不匹配的请求会透传（诊断页可见） |

## 许可

[MIT](LICENSE) © mafeis
