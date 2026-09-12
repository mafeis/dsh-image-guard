# dsh-image-guard

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![version](https://img.shields.io/badge/version-0.8.4-informational.svg)
![tests](https://img.shields.io/badge/tests-68%20passing-brightgreen.svg)
![dsh plugin](https://img.shields.io/badge/DSH-plugin-8b5cf6.svg)

**在请求发送前将历史图片裁剪至预算内；上游因图片数量返回 400 时，自动解析其上限并降级重试。**

> DSH（DeepSeek Harness）插件。用于避免含图会话因上游图片数量限制而持续返回 400，并降低每轮的视觉 token 消耗。
>
> *Trims historical images to a budget before each request, learns the provider image cap from its HTTP 400 response, and retries with a degraded payload.*

**目录**：[快速开始](#快速开始) · [功能与实现](#功能与实现) · [工作原理](#工作原理) · [400 的成因](#400-的成因) · [省略标记](#省略标记) · [配置](#配置) · [观测](#观测) · [实测数据](#实测数据) · [设计约束与已知限制](#设计约束与已知限制) · [开发与测试](#开发与测试) · [Roadmap 图床](#roadmap-图床) · [疑难排查](#疑难排查)

## 快速开始

### 安装（DSH Desktop）

建议通过 GUI 插件市场安装。手动安装时需注意：DSH Desktop 加载的是 `desktop` profile。

```sh
# 1) 编辑 <DSH_HOME>/profiles/desktop/package.json
#    dependencies 增加          "dsh-image-guard": "github:mafeis/dsh-image-guard"
#    dsh.profile.bundles 追加   "dsh-image-guard"
# 2) 安装依赖并重启 DSH Desktop
cd <DSH_HOME>/profiles/desktop && pnpm install --prefer-offline --ignore-scripts
```

> **注意**：`desktop` 为 Electron 持有的 profile 名称，启动器会拒绝对其执行插件管理请求，因此 `dsh plugin --profile desktop add …` 不可用。
> 此外，在 profile 的 `cordis.patch.yml` 中手写 `insert` 条目不会加载插件——GUI 的已安装插件列表仅识别 `dependencies` 与 `dsh.profile.bundles`。

### 安装（命令行 profile）

```sh
dsh plugin --profile <name> add github:mafeis/dsh-image-guard
```

### 验证是否生效

1. 打开 设置 → 图片守卫 → 诊断，确认「守卫已接入 fetch 链」且链上探针计数增加；
2. 观察 `~/.dsh/image-guard-status.json` 的 `chatPosts` 字段开始增长；
3. 如需先观察再启用，将 参数 → `dryRun` 打开，仅记录将被裁剪的图片而不修改请求。

## 功能与实现

| | |
|---|---|
| **功能** | ① 历史图片不再保留在上下文中，降低每轮视觉 token 消耗；② 请求中的图片数量不再无界增长；③ 已超限的会话自动降级恢复，无需放弃会话 |
| **实现** | 包装 `globalThis.fetch`，仅处理「`POST` + 聊天补全路径 + 含图片」的 JSON 请求：保留最近 `keepRecent` 张，其余替换为**可识别标记**；上游仍返回 `At most N image(s)` 时解析上限 N，按 N−1 张重发（解析到上限后，同进程内后续请求直接按 N−1 张发送） |
| **效果** | ① 每张被裁剪的图片约省 **972 视觉 token**（实测上限，扣除标记开销约 40），14 张裁剪至 7 张约**每轮省 6.5k token**，设置页显示累计节省量；② 实测 14 张图的会话由「每次请求均返回 400、compact 亦失败」变为**仅需一次 400 重试**，之后稳定按 7 张发送；③ 请求体体积相应从 MB 级下降 |

## 工作原理

```
DSH agent
   │  POST /v1/chat/completions          image_url: data:image/png;base64,…
   ▼
┌────────────────── fetch 链 ──────────────────┐
│  image-guard        ← 裁剪、解析上限、降级重试 │  必须位于此层
│       ▼                                      │  见下文「包装顺序」
│  dsh-net-proxy      ← 走代理时使用自带 net/tls │
│                       socket 发包，绕过下层    │
└──────────────────────────────────────────────┘
   ▼
vLLM / OpenAI 兼容网关        --limit-mm-per-prompt.image N
```

1. 仅处理「`POST` + 路径匹配 `matchPath` + 请求体含图片」的 JSON 请求，其余请求原样放行；
2. 按「旧 → 新」递归收集全部图片，保留**最新** `keepRecent` 张；
3. 其余每张替换为标记（文件名 / 指纹 / 取回提示）；
4. 发送——请求体为 `structuredClone` 的副本，会话历史不作修改；
5. 上游返回 `At most N image(s)` 时解析上限 N，按 N−1 张重发，最多 `maxRetries` 次。

**包装顺序**：net-proxy 在真正走代理时使用自带 socket 发包，会绕过其下层的一切 fetch 包装器；而它的「跟随系统代理」会在系统代理变更时将其自身重新安装到链首，即后安装者位于链首，包装顺序可能变化。因此本插件使用 **1 秒看门狗 + 链上探针**确保自身始终位于最上层（在链首完成裁剪后再交由下层，行为不变），最多重新接入 5 次以避免包装器相互嵌套。更彻底的方案是将 LLM 网关域名加入 net-proxy 的 `noProxy`。

## 400 的成因

会话中保存的是图片**引用**（附件 id 与名称 / 尺寸），界面显示为图片引用；但装配请求时会被**内联为实际字节**：

```js
image_url: { url: `data:${mime};base64,${data}` }   // dsh-llm-deepseek 与 pi-ai/openai-completions 均如此
```

因此两侧的计量口径不一致：

| | 客户端（`llm-pi-ai` 路由预算） | 服务端（vLLM） |
|---|---|---|
| 计量对象 | 字节 / 像素 | **图片张数** |
| 默认值 | 20 MiB / 2048² / 单张 1 MiB | `--limit-mm-per-prompt.image N` |
| 14 张 ≈ 9 MB | 未超限 → **不裁剪** | 14 > 8 → **400** |

pi-ai 路由**没有图片数量预算**（`maxImages` 仅原生 `dsh-llm-deepseek` 可配置，默认 600），因此该失败模式在 OpenAI 兼容网关上必然发生；本插件补充的正是**按张数**、且会向服务端学习的上限控制。

> **注意**：`--limit-mm-per-prompt.image` 按**整个 prompt**（即整份对话历史）计数，设为 8 时，累计 9 张图片的会话将永久返回 400，compact 压缩同样无法规避。

## 省略标记

被裁剪的图片不使用无信息量的占位文案，而是替换为**可供模型 / agent 找回原图的标记**：

| 场景 | 标记 |
|---|---|
| 有路径（常态，默认仅文件名） | `[图片已省略 #1 · 01-race-start.png · 需要时按文件名在工作区内搜索后读取]` |
| `pathMode=full`（显式选择） | `[图片已省略 #1 · C:\path\to\shots\01-race-start.png · 需要时用 read_image 重新读取]` |
| 仅有附件元数据 | `[图片已省略 #1 · 01-race-start.png · 内联图片 sha256:bf23bcd3 (image/png 1280x720 618 KiB) · 无原文件路径，已无法取回]` |
| 远端 URL | `[图片已省略 #1 · race.png · https://…/race.png · 需要时可重新访问该地址]` |

取值顺序：相邻文本片段中的 `<path>` / 文件名 / 尺寸 / 字节 → 远端 URL → 内联数据的 **sha1 指纹**（「前 4 KB + 总长」，同一张图的标识始终一致）。无法取回时明确标注不可恢复，不使模型依赖记忆推断。

模板（`placeholder`）支持 `{index} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}`；另有 `{total}` `{kept}`，但二者随会话增长而变化，会导致被省略位置之后的**前缀缓存失效**，默认不使用。

> **注意**：标记会随请求体发送至服务端，因此默认 `pathMode: "basename"` 仅包含文件名，目录结构与盘符不外发（`relative` 仅提供相对工作区 / `~` 的路径，`none` 不包含文件名）。

## 配置

配置文件为 `~/.dsh/image-guard.json`（**修改后热更新，无需重启**）；亦可经设置页或 `/_dsh/image-guard` 路由修改。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后完全透传 |
| `keepRecent` | `12` | 保留最近几张图片，其余替换为标记；`0` 表示全部替换 |
| `maxRetries` | `3` | 上游返回 400 后的最大降级重发次数 |
| `learnLimit` | `true` | 是否从 400 响应中解析服务端上限 |
| `dryRun` | `false` | 仅观察，不修改请求 |
| `matchPath` | `/chat/completions\|/messages` | 仅处理匹配的路径（正则） |
| `placeholder` | `[图片已省略 #{index}{identity}{hint}]` | 标记模板 |
| `pathMode` | `basename` | `full` / `relative` / `basename` / `none` |
| `tokensPerImage` | `972` | 估算节省量所用的单张图片视觉 token 数；`0` 表示不估算 |
| `verbose` | `true` | 输出日志 |

## 观测

**设置页**（设置 → 图片守卫）：仅占一个一级菜单，页内为三个二级 tab——**总览**（功能说明、实时统计、关键开关）、**参数**（全部可调项与标记预览）、**诊断**（链路状态、统计明细、最近 12 条请求形态）。

**状态文件** `~/.dsh/image-guard-status.json`：`chatPosts` `bundled` `trimmed` `imagesDropped` `retried` `learnedLimit` `maxSeen` `tokensSaved`，以及 `fetchOwned` `probes` `probeSeen`（探针为 0 表示未接入链）与 `diag`（最近 40 条请求形态：`input` / `body` / `bytes` / `imgs` / `msgs`，用于排查未被拦截的请求）。

**路由** `/_dsh/image-guard`：`GET` 读取、`PUT` 写入、`POST ?reset=1` 恢复默认、`POST ?rewrap=1` 强制重新接入。

## 实测数据

| 省 token | 实测值 |
|---|---|
| 单张图片视觉 token | 197（简单图）～ 972（该路由上限） |
| 标记开销 | ≈ 40 token / 张 |
| 每次裁剪净省 | ≈ 930 token |
| 14 张裁剪至 7 张 | ≈ 6.5k token / 轮 |

| 图片对时延的影响 | 实测值 |
|---|---|
| 单图加入 15 万 token 请求 | +105 ～ 181 ms（图片不是延迟的主要来源） |
| prefill | ≈ 6.5k token/s（首 token ≈ prompt ÷ 6.5k） |
| decode | 与上下文长度无关（4k / 40k / 184k → 542 / 555 / 722 tok/s） |
| 前缀缓存 | 第 3 次命中时 TTFT 由 7.5 s 降至 0.33 s |

| 传输方式对照（同一张图） | 状态 | 耗时 | 视觉 token | 请求体 |
|---|---|---|---|---|
| 纯文本 | 200 | 267 ms | 13 | ≈0 KB |
| 1 图 `data:` URL（现状） | 200 | 333 ms | **197** | 21 KB |
| 1 图 远端 `https:` URL | **200** | 1515 ms | **197** | **≈0 KB** |
| 4 图 `data:` URL | 200 | 297 ms | **755** | 82 KB |
| 4 图 远端 `https:` URL | **200** | 891 ms | **755** | **≈0 KB** |
| 1 图 URL 复测 | 200 | 510 ms | 197 | ≈0 KB |

## 设计约束与已知限制

**设计约束**

- **不修改会话历史**：仅在 `structuredClone` 的请求体副本上替换，前缀缓存保持有效，关闭插件即恢复原状。
- **不重发已发出的请求**：上游报错 / 中断原样抛给调用方，单次中断不会产生两次请求。
- **宁可漏过，不可误伤**：非 JSON 请求、非聊天补全路径、`FormData`、流式请求一律放行。
- **不推测上限**：上限仅从上游 400 响应中解析，解析失败则原样返回响应。
- **请求形态使用鸭子类型判定**：宿主可能传入跨 realm 的 `Request`，使用 `instanceof` 会将 method 误判为 GET 而跳过整个请求。
- **失败不静默**：初始化异常时仅跳过本插件并输出原因，不影响宿主启动。

**已知限制**

| 限制 | 说明 |
|---|---|
| 仅控制**图片张数** | 不压缩、不缩放图片；字节超限不在处理范围 |
| 首次仍会产生一次 400 | 上限仅在收到 400 响应后可获知 |
| 仅节省历史图片的 token | 最新 N 张按原样发送（字节同样发送） |
| 看门狗最多重新接入 5 次 | 避免包装器相互嵌套；超出后在诊断页标记异常 |
| 已内联且无路径的图片无法恢复 | 标记中仅提供指纹与「无法取回」说明 |
| 依赖 DSH 当前的请求形态 | 形态变化时请求将被放行（诊断页可见） |

## 开发与测试

```
lib/     index.js（fetch 包装 / 看门狗 / 探针 / 统计 / 路由）· shapes.js（形态识别 + 递归收集替换 + 标记渲染）
         decide.js（保留张数 / 是否裁剪 / 是否放弃 / 已解析上限）· config.js · routes.js · client.js（设置页）
tests/   68 项纯 node 测试，无测试框架      tools/   会话日志（多帧 zstd）排障工具      market/   插件市场投稿 YAML
```

```sh
npm test   # 68 项：决策/配置/路由 16 · 守卫 7 · 请求形态 7 · 中断 2 · 客户端 13 · 标记 16 · 自检 7
```

投稿至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的要求：仓库需声明 **`dsh.bundle`**（仅声明 `dsh.client` 无法安装，为最常见的拒绝原因）、创建满 **1 天**、带 **`dsh-plugin`** topic，然后向 `data/plugins/mafeis__dsh-image-guard.yml` 提交 PR（`market/` 目录已备好该文件）。

## Roadmap 图床

以 URL 传输图片，以节省上传字节（数据见[实测数据](#实测数据)中的传输方式对照）：

- 远端 URL **可用**，且**不改变 token 数**（视觉 token 由像素决定）；节省的是上传字节（14 张 ≈ 9 MB → ≈ 0 KB）与客户端 base64 编码开销。
- 多图**不呈线性增加耗时**：第 2～4 张平均 ≈ 198 ms / 张；同一 URL 复测由 1515 ms 降至 510 ms（存在抓取缓存）。
- 首要风险为**后端可达性**：实测同一后端抓取 `python.org` 耗时 1.5 s 成功，而 `upload.wikimedia.org` 超时 300 s 后返回 504；一个不可达的 URL 会占用一个并发槽位约 5 分钟。
- 因此需要：内容寻址（`sha256 → URL`，保证 token 稳定）、URL 不含过期签名、上传幂等、抓取失败回退 `data:`、新 host 先以 1×1 图探测并将不可达 host 加入黑名单。

> 与节省 token 的组合方式：**新图以 URL 传输节省字节 + 历史图以标记节省 token**。

## 疑难排查

**「Request timed out.」是否由本插件引起？** 否。该错误来自 openai SDK 6.26.0（`timeout = options.timeout ?? 10 分钟`），路由未配置 `timeoutMs` 时使用默认值；pi-ai 还关闭了 SDK 自带重试（`maxRetries: 0`），由 DSH 的 retryPolicy 重试。该错误通常是**现象**而非原因：请求实际耗时超过 10 分钟（共享 vLLM 被长 prefill 阻塞时，单路 decode 约为 5～10 tok/s）。如需放宽，可在路由上配置 `timeoutMs`。net-proxy 不是来源，其错误措辞为 `timeout after Xms` / `response idle timeout`。

**插件已启用但仍返回 400？** 首先查看**诊断 tab 的链路状态**：显示「未接入链」或「链上探针 0 / N」表示请求绕过了守卫（典型原因是上文所述包装顺序）；若状态正常但 `imgs` 明显少于实际图片数，说明请求形态不匹配而被放行（可在诊断页对照）；此外需确认服务端 `--limit-mm-per-prompt.image` 未被设为 0（该值会完全禁止图片）。

## 许可

[MIT](LICENSE) © mafeis
