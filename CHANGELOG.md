# Changelog

语义化版本。这里只记**变更本身**；原理、实测数据与用法见 [README](README.md)。

## 0.8.8 — 2026-09-12

**文档、表述与打包整理**（合并记录 0.8.3–0.8.8 期间的整理工作）

- README 收敛为双语：`README.md`（中文，默认）与 `README.en.md`（英文），互相链接；篇幅压缩至约 105 行，仅保留与本插件相关的内容（移除上游实现分析、性能实测与可行性探测）。
- README、CHANGELOG、设置页文案、源码注释与运行日志统一为技术文档文体，去除口语化表述与表情符号。
- 打包与规范：新增 `.github/workflows/test.yml`（无需安装依赖即可运行 68 项测试）与 `CONTRIBUTING.md`；移除无对应依赖的 `lint` 脚本；`@deepseek-ai/schemastery` 的 peer 范围加入预发布分支；市场条目补充 Release tarball 地址。
- 移除平台相关与冗余内容：删除 `tools/`（PowerShell 部署脚本、会话日志排障工具）与未使用的 `DEFAULT_PLACEHOLDER` 别名。

## 0.8.2 — 2026-09-12

**新增**：README 补齐徽章、目录、工作原理（fetch 链图 + 决策步骤）、已知限制、常见问题。

**修复**

- 桌面端安装说明：`desktop` 是 Electron 保留的 profile 名，`dsh plugin --profile desktop …` 会被启动器拒绝；
  桌面端改为 GUI 安装，或手改 profile 的 `dependencies` + `dsh.profile.bundles` 后 `pnpm install`。
- 测试数更新 48 → 68。

**变更**：删除与 `market/*.yml` 重复的 `plugins-entry.json`。

## 0.8.1 — 2026-09-12

- 设置页只注册一个一级菜单「图片守卫」，参数与诊断改为页内二级 tab（原生 `Pill`）。
- 控件改用原生原子：`Switch` / `Tag` / `Button`。

## 0.8.0 — 2026-09-12

- 设置页新增总览页：干了什么 / 怎么做的 / 有什么效果 + 实时统计 + 关键开关。

## 0.7.1 — 2026-09-12

- 修复：图片嵌在 `tool-result` 内层 `content` 时既统计不到也裁剪不掉（改为按路径递归遍历并就地替换）。
- 「保留最新、丢弃最早」语义加入逐张断言。

## 0.7.0 — 2026-09-12

- 新增省 token 量化：`tokensPerImage`（默认 972）、`tokensSaved`，设置页显示「省 Nk tok」。

## 0.6.0 — 2026-09-12

- 设置页瘦身至首屏不出滚动条。

## 0.5.0 — 2026-09-12

- 新增 fetch 链上自检与自愈：链上探针、1 秒看门狗、`POST ?rewrap=1` 强制重新接管，状态里带 `pid`。
- 设置页在「不在链上」时给出告警与一键重新接管。
- 修复：包装器被重新安装到链首后静默失效导致的未拦截。

## 0.4.0 — 2026-09-12

- 新增 `pathMode` 路径脱敏（`full` / `relative` / `basename` / `none`，默认 `basename`）。
- 修复：测试改用 `DSH_IMAGE_GUARD_CONFIG` 隔离，不再受真实配置影响。

## 0.3.0 — 2026-09-12

- 文档改为「干了什么 / 怎么做的 / 有什么效果」三段式。
- 补充 400 与超时的成因分析。

## 0.2.1 — 2026-09-12

- 省略标记携带身份：路径 / 文件名 / 指纹 / 取回方式；支持 `placeholder` 模板与设置页实时预览。

## 0.2.0 — 2026-09-12

- 新增设置页：开关与参数表单、实时统计、最近请求形态诊断。

## 0.1.0 — 2026-09-12

- 首次发布：按张数裁剪历史图片（`keepRecent`），从 `At most N image(s)` 响应中解析上限并降级重试。
- 配置热更（`~/.dsh/image-guard.json`）、状态文件与路由（`/_dsh/image-guard`）、`dryRun` 观察模式。
- 纯 node 测试；会话日志（多帧 zstd）排障工具。
