# 贡献指南

本仓库是 DSH（DeepSeek Harness）插件 `dsh-image-guard` 的源码。提交改动前请先读 [README](README.md)（英文版 [README.en.md](README.en.md)）。

## 目录结构

```
lib/      index.js（fetch 包装 / 看门狗 / 探针 / 统计 / 路由）· shapes.js（请求形态识别 + 递归收集替换 + 标记渲染）
          decide.js（保留张数 / 是否裁剪 / 是否放弃 / 已解析上限）· config.js · routes.js · client.js（设置页）
tests/    82 项测试，纯 node，无测试框架
```

## 测试

```sh
npm test   # 82 项：决策/配置/路由 22 · 守卫 7 · 请求形态 7 · 中断 2 · 客户端 19 · 标记 18 · 自检 7
```

测试只使用 Node 内置模块，**不需要安装任何依赖，也不需要联网**（Node 20 及以上）。CI 在 push 与 PR 时运行同一命令。

## 约定

- 请求形态的判定使用鸭子类型，不使用 `instanceof Request`；非 JSON、非聊天补全路径、`FormData`、流式请求一律透传。
- 不修改会话历史：仅在 `structuredClone` 的请求体副本上替换。
- 新增或修改行为时同步更新 `tests/` 与 `CHANGELOG.md`；版本号遵循语义化版本。
- 跨平台：不引入平台相关脚本（`.ps1` / `.cmd` / shell 脚本）或平台相关依赖；路径统一用 `node:path` 与自定义归一化，不依赖宿主分隔符。测试在 Windows 与 Linux 上都必须全绿。
- 文档、注释与日志使用技术文档文体（不使用口语与表情符号）；示例一律使用 `C:\path\to\...` 形式的通用路径，不得出现真实本机目录、盘符或用户名。
