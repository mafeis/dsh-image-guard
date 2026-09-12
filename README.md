# dsh-image-guard

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![version](https://img.shields.io/badge/version-0.8.3-informational.svg)
![tests](https://img.shields.io/badge/tests-68%20passing-brightgreen.svg)
![dsh plugin](https://img.shields.io/badge/DSH-plugin-8b5cf6.svg)

**让看图多的会话不再被 `400` 锁死，并每轮省下大量视觉 token。**

> 发送前把历史旧图裁到预算内；服务端仍因图片数量拒绝时，从它的报错里学出上限并自动降级重试。
>
> *Keeps image-heavy DSH sessions alive: trim older images to a budget, learn the provider's image cap from its `400`, and retry instead of letting the session die.*

**目录**：[快速开始](#快速开始) · [它做了什么](#它做了什么) · [工作原理](#工作原理) · [为什么会被 400](#为什么会被-400) · [省略标记](#省略标记) · [配置](#配置) · [观测](#观测) · [实测数据](#实测数据) · [设计约束与已知限制](#设计约束与已知限制) · [开发与测试](#开发与测试) · [Roadmap 图床](#roadmap-图床) · [常见问题](#常见问题)

## 快速开始

### DSH Desktop

推荐在 GUI 里装（插件市场 / 已安装插件）。手动装的话，桌面端加载的是 `desktop` profile：

```sh
# 1) 编辑 <你的 .dsh>/profiles/desktop/package.json
#    dependencies 增加          "dsh-image-guard": "github:mafeis/dsh-image-guard"
#    dsh.profile.bundles 追加   "dsh-image-guard"
# 2) 装依赖并重启 DSH Desktop
cd <你的 .dsh>/profiles/desktop && pnpm install --prefer-offline --ignore-scripts
```

> ⚠️ 别用 `dsh plugin --profile desktop add …`：`desktop` 是 Electron 保留的 profile 名，启动器会拒绝对它的插件管理请求。
> 同样，在 profile 的 `cordis.patch.yml` 里手写 `insert` **不会**加载插件——GUI 只认 `dependencies` + `dsh.profile.bundles`。

### 命令行 profile

```sh
dsh plugin --profile web add github:mafeis/dsh-image-guard   # 换成你自己的 profile 名
```

### 确认生效

1. 设置 → 图片守卫 → 诊断：「守卫在 fetch 链上」，且链上探针计数在涨；
2. `~/.dsh/image-guard-status.json` 的 `chatPosts` 开始增长；
3. 想先不开刀：**参数 → dryRun** 打开，只看它会裁什么。

## 它做了什么

| | |
|---|---|
| **干了什么** | ① 历史旧图不再堆在上下文里 → **每轮省下大量视觉 token**；② 图片数量不再无界增长；③ 已超限的会话自动救回来，而不是报废 |
| **怎么做的** | 包装 `globalThis.fetch`，只拦「`POST` + 聊天补全路径 + 真带图」的 JSON 请求：保留最近 `keepRecent` 张，其余换成**带身份的标记**；若上游仍回 `At most N image(s)`，学出 N → 按 N−1 张重发（学到之后，同进程内后续请求直接按 N−1 发） |
| **有什么效果** | ① 每丢一张图省 ≈ **972 视觉 token**（扣掉标记开销 ≈40），14 张裁到 7 张 ≈ **每轮省 6.5k token**，设置页显示累计「省 Nk tok」；② 实测 14 张图的会话从「每个请求都 400、连 compact 都挂」变为**只付一次 400**，之后稳定按 7 张发；③ 请求体同步从 MB 级降下来 |

## 工作原理

```
DSH agent
   │  POST /v1/chat/completions          image_url: data:image/png;base64,…
   ▼
┌────────────────── fetch 链 ──────────────────┐
│  image-guard        ← 裁剪、学上限、降级重发   │  必须在这一层
│       ▼                                      │  见下方「抢链首」
│  dsh-net-proxy      ← 走代理时用自带 net/tls   │
│                       socket 发包，绕过下层    │
└──────────────────────────────────────────────┘
   ▼
vLLM / OpenAI 兼容网关        --limit-mm-per-prompt.image N
```

1. 只认「`POST` + 路径命中 `matchPath` + body 里真有图」的 JSON 请求，其余原样放行；
2. 按「旧 → 新」递归收集全部图片，保留**最新** `keepRecent` 张；
3. 更早的每张 → 换成标记（文件名 / 指纹 / 取回提示）；
4. 发出——body 是 `structuredClone` 的副本，会话历史一个字不改；
5. 上游若回 `At most N image(s)`：学出 N → 按 N−1 张重发，最多 `maxRetries` 次。

**抢链首**：net-proxy 真正走代理时用自带 socket 发包，会绕过它下层的一切 fetch 包装器；而它的「跟随系统代理」会在系统代理变动时把自己重新装到链首——谁最后装谁在上，顺序会翻转。所以本插件用 **1 秒看门狗 + 链上探针**保证自己始终在最上层（在链首裁完再交给下层，行为不变），最多重接管 5 次以防互相套娃。更彻底的办法：把 LLM 网关域名加进 net-proxy 的 `noProxy`。

## 为什么会被 400

会话里存的是**引用**（附件 id + 名字 / 尺寸），界面上看着像"地址"；装配请求时会被**内联成真字节**：

```js
image_url: { url: `data:${mime};base64,${data}` }   // dsh-llm-deepseek 与 pi-ai/openai-completions 都如此
```

于是两边的尺子量的不是一个东西：

| | 客户端（`llm-pi-ai` 路由预算） | 服务端（vLLM） |
|---|---|---|
| 量什么 | 字节 / 像素 | **张数** |
| 默认 | 20 MiB / 2048² / 单张 1 MiB | `--limit-mm-per-prompt.image N` |
| 14 张 ≈ 9 MB | 没超 → **不裁** | 14 > 8 → **400** |

pi-ai 这条路**没有数量预算**（`maxImages` 只有原生 `dsh-llm-deepseek` 可配，默认 600），所以这个失败模式在 OpenAI 兼容网关上必然踩；本插件补的正是**按张数**、且会向服务端学习的那道闸。

> `--limit-mm-per-prompt.image` 按**整个 prompt**（= 整份对话历史）计，设成 8 会让攒够 9 张图的会话永久 400——连 compact 都救不了。

## 省略标记

不是"图片已省略"这种废话，而是**能让模型 / agent 找回去的标记**：

| 场景 | 标记 |
|---|---|
| 有路径（常态，默认只给文件名） | `[图片已省略 #1 · 01-race-start.png · 需要时按文件名在工作区内搜索后读取]` |
| `pathMode=full`（显式选择） | `[图片已省略 #1 · C:\path\to\shots\01-race-start.png · 需要时用 read_image 重新读取]` |
| 只有附件元数据 | `[图片已省略 #1 · 01-race-start.png · 内联图片 sha256:bf23bcd3 (image/png 1280x720 618 KiB) · 无原文件路径，已无法取回]` |
| 远端 URL | `[图片已省略 #1 · race.png · https://…/race.png · 需要时可重新访问该地址]` |

取值顺序：旁边文本片段里的 `<path>` / 文件名 / 尺寸 / 字节 → 远端 URL → 内联数据的 **sha1 指纹**（「前 4 KB + 总长」，同一张图始终同一个 id）。取不回就明说取不回，不让模型凭记忆猜。

模板（`placeholder`）可用 `{index} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}`；另有 `{total}` `{kept}`，但它们随会话增长而变，会让被省略位置之后的**前缀缓存失效**，默认刻意不带。

🔒 标记最终会进请求体、发给服务端，所以默认 `pathMode: "basename"`：只给文件名，目录结构与盘符不出本机（`relative` 只给相对工作区 / `~` 的路径，`none` 连文件名都不给）。

## 配置

`~/.dsh/image-guard.json`（**热更，免重启**）；也可用设置页或 `/_dsh/image-guard` 路由改。

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关，关掉即完全透明 |
| `keepRecent` | `12` | 保留最近几张图，其余换标记；`0` = 全换 |
| `maxRetries` | `3` | 400 后最多降级重发几次 |
| `learnLimit` | `true` | 是否从 400 报文学习服务端上限 |
| `dryRun` | `false` | 只观察不修改 |
| `matchPath` | `/chat/completions\|/messages` | 命中哪些路径才处理（正则） |
| `placeholder` | `[图片已省略 #{index}{identity}{hint}]` | 标记模板 |
| `pathMode` | `basename` | `full` / `relative` / `basename` / `none` |
| `tokensPerImage` | `972` | 估算省 token 用的每张图视觉 token 数；`0` = 不估算 |
| `verbose` | `true` | 打日志 |

## 观测

**设置页** `dsh 设置 → 图片守卫`：一个一级菜单 + 页内三个二级 tab —— **总览**（作用说明 + 实时统计 + 关键开关）、**参数**（可调项 + 标记预览）、**诊断**（链路健康 / 统计明细 / 最近 12 条请求形态）。

**状态文件** `~/.dsh/image-guard-status.json`：`chatPosts` `bundled` `trimmed` `imagesDropped` `retried` `learnedLimit` `maxSeen` `tokensSaved`，以及 `fetchOwned` `probes` `probeSeen`（探针为 0 即不在链上）和 `diag`（最近 40 条请求形态：`input` / `body` / `bytes` / `imgs` / `msgs`，漏拦时看这个）。

**路由** `/_dsh/image-guard`：`GET` 读、`PUT` 写、`POST ?reset=1` 恢复默认、`POST ?rewrap=1` 强制重新接管。

## 实测数据

| 省 token | 实测值 |
|---|---|
| 单张图视觉 token | 197（简单图）～ 972（该路由上限） |
| 标记开销 | ≈ 40 token / 张 |
| 每次驱逐净省 | ≈ 930 token |
| 14 张裁到 7 张 | ≈ 6.5k token / 轮 |

| 图片对时延的影响 | 实测值 |
|---|---|
| 单图加进 15 万 token 请求 | +105 ～ 181 ms（图片不是慢的原因） |
| prefill | ≈ 6.5k token/s（首 token ≈ prompt ÷ 6.5k） |
| decode | 与上下文长度无关（4k / 40k / 184k → 542 / 555 / 722 tok/s） |
| 前缀缓存 | 第 3 次命中 TTFT 7.5 s → 0.33 s |

| 传输方式对照（同一张图） | 状态 | 耗时 | 视觉 token | 请求体 |
|---|---|---|---|---|
| 纯文本 | 200 | 267 ms | 13 | ≈0 KB |
| 1 图 `data:` URL（现状） | 200 | 333 ms | **197** | 21 KB |
| 1 图 远端 `https:` URL | **200** | 1515 ms | **197** | **≈0 KB** |
| 4 图 `data:` URL | 200 | 297 ms | **755** | 82 KB |
| 4 图 远端 `https:` URL | **200** | 891 ms | **755** | **≈0 KB** |
| 1 图 URL 复测 | 200 | 510 ms | 197 | ≈0 KB |

## 设计约束与已知限制

**刻意如此**

- **不改会话历史**：只在 `structuredClone` 的请求体副本上替换 → 前缀缓存仍有效，关掉即恢复。
- **不重发**：请求一旦发出，上游报错 / 中断原样抛给调用方（一次中断绝不变成两次请求）。
- **宁可漏，不可误伤**：非 JSON、非聊天补全路径、`FormData`、流式请求一律放行。
- **不猜上限**：只从上游 400 报文里学，解析不到就把响应原样交回。
- **鸭子类型判定请求**：宿主可能送来跨 realm 的 `Request`，用 `instanceof` 会把 method 误判成 GET 而整条跳过。
- **失败不静默**：初始化异常只跳过本插件并打印原因，不影响宿主启动。

**限制**

| 限制 | 说明 |
|---|---|
| 只管**张数** | 不压缩 / 不缩放图片；字节超预算不归它 |
| 第一次仍要付一次 400 | 上限只在收到 400 后才知道 |
| 只省历史图的 token | 最新 N 张照原样发送（字节照付） |
| 看门狗最多重接管 5 次 | 防互相套娃，超限则放弃自愈并在诊断页标红 |
| 已被内联且无路径的图取不回 | 标记里只能给指纹与"取不回"的说明 |
| 依赖 DSH 当前的请求形态 | 形态变了会放行（诊断页能看出） |

## 开发与测试

```
lib/     index.js（fetch 包装 / 看门狗 / 探针 / 统计 / 路由）· shapes.js（形态识别 + 递归收集替换 + 标记渲染）
         decide.js（保留几张 / 是否裁 / 是否放弃 / 学到的上限）· config.js · routes.js · client.js（设置页）
tests/   68 项纯 node 测试，无框架      tools/   会话日志（多帧 zstd）排障工具      market/   市场投稿 YAML
```

```sh
npm test   # 68 项：决策/配置/路由 16 · 守卫 7 · 请求形态 7 · 中断 2 · 客户端 13 · 标记 16 · 自检 7
```

投稿到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：仓库需声明 **`dsh.bundle`**（只写 `dsh.client` 装不上，最常见被拒原因）、创建满 **1 天**、带 **`dsh-plugin`** topic，然后往 `data/plugins/mafeis__dsh-image-guard.yml` 开 PR（`market/` 里已备好）。

## Roadmap 图床

用 URL 发图，省上传字节（数据见[实测数据](#实测数据)的传输方式对照）：

- 远端 URL **可用**，且**不改变 token 数**（视觉 token 由像素决定）；省的是上传字节（14 张 ≈ 9 MB → ≈ 0 KB）与客户端 base64 开销。
- 多图**不线性变慢**：第 2～4 张平均 ≈ 198 ms / 张；同一 URL 复测 1515 → 510 ms（有抓取缓存）。
- 🚨 头号风险是**后端可达性**：实测同一后端抓 `python.org` 1.5 s 成功，`upload.wikimedia.org` 卡满 300 s 后 504——一个不可达的 URL 会白占一个并发槽 5 分钟。
- 因此需要：内容寻址（`sha256 → URL`，保证 token 稳定）、URL 不带过期签名、上传幂等、抓取失败回退 `data:`、新 host 先探一次（1×1 图）并拉黑不可达的。

> 与省 token 的组合：**新图走 URL 省字节 + 老图换标记省 token**。

## 常见问题

**「Request timed out.」是本插件导致的吗？** 不是。它来自 openai SDK 6.26.0（`timeout = options.timeout ?? 10 分钟`），路由没配 `timeoutMs` 就吃默认值；pi-ai 还关掉了 SDK 自带重试（`maxRetries: 0`），由 DSH 的 retryPolicy 重试。它多半是**症状**：请求真的跑了 >10 分钟（共享 vLLM 被长 prefill 饿死时单路 decode 只有 5～10 tok/s），要放宽就在路由上加 `timeoutMs`。net-proxy 不是元凶——它的措辞是 `timeout after Xms` / `response idle timeout`。

**开了插件还是会话 400？** 先看**诊断 tab 的链路健康**：「未在链上」或「链上探针 0 / N」→ 请求绕过了守卫（典型原因就是上面那条抢链首规则）；一切正常但 `imgs` 明显少于你看到的图片数 → 形态不符被放行（诊断页可对照）；再看服务端 `--limit-mm-per-prompt.image` 是否被设成 0（那样彻底不允许图片）。

## 许可

[MIT](LICENSE) © mafeis
