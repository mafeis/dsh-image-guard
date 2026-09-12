# 投稿 PR 正文（粘贴到 awesome-dsh-plugin 的 PR 描述里）

对应的条目文件：`market/mafeis__dsh-image-guard.yml` → 提交时放到 `data/plugins/mafeis__dsh-image-guard.yml`。

---

- [x] I added **one file** at `data/plugins/mafeis__dsh-image-guard.yml` — that single file is the whole submission. The READMEs are regenerated on `main` after merge: don't edit them by hand, and you don't need to commit them either / 我新增了一个 `data/plugins/mafeis__dsh-image-guard.yml` 文件——**这一个文件就是全部投稿**
- [x] My repo's `package.json` declares **`dsh.bundle`** (not just `dsh.client`) / 仓库 `package.json` 已声明 `dsh.bundle`（`dsh.bundle.patch` → `./cordis.patch.yml`，位于仓库根）
- [x] My repo is at least **1 day old** / 仓库创建满 1 天
- [x] `category` is `vision` / `category` 取值为 `vision`（插件处理的是请求中的图片：按张数裁剪历史图片、解析上游图片数量上限）
- [x] Description states what the plugin does, no superlatives / 描述只说功能，不带营销词
- [x] My repo has the `dsh-plugin` topic / 仓库已打 `dsh-plugin` topic

**What it does / 插件做什么**

Dsh-image-guard 包装 `globalThis.fetch`：在请求发送前把历史图片裁剪到 `keepRecent` 张（默认 12），被裁剪的图片替换为可识别标记（文件名 / 路径 / 指纹 / 取回方式）；当上游因图片数量返回 400（`At most N image(s) may be provided in one prompt`）时解析该上限 N，并按 N−1 张重试，同进程内后续请求直接沿用该上限。

- 缓存前缀不受影响：仅替换 `structuredClone` 后的请求体，会话历史不作修改。
- 每张被裁剪的图片约省 930 视觉 token（实测上限 972 − 标记开销约 40）；14 张裁剪至 7 张约每轮省 6.5k token。
- 设置页只占一个一级菜单（页内三个二级 tab：总览 / 参数 / 诊断），配置文件 `~/.dsh/image-guard.json` 热更新。
- 测试：68 项，纯 Node 内置模块，`npm test` 无需安装依赖、无需联网。

**Recommended items / 推荐项**

- 📦 npm：未发布；已在 GitHub Release 附加 `npm pack` 产物（`tarball:` 字段指向 `releases/latest/download/dsh-image-guard.tgz`，文件名不含版本号，不会随发版失效），安装无需构建授权。
- 🔗 官方包：`@deepseek-ai/schemastery` 声明在 `peerDependencies`（带预发布分支的显式范围），不在 `dependencies`。
- 🖼️ 截图：暂未提供 `screenshots.json`；设置页截图整理后会推送到本仓库，不需要再提 PR。
