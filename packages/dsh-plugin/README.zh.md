# @cortexkit/dsh-magic-context

DeepSeek Harness (DSH) 上的 Magic Context — 长会话不丢失历史，且始终在上下文窗口内。

持久 DSH 插件（Host / Agent / Client 三面 + profile bundle），复用 Magic Context 共享 SQLite（`harness='dsh'` 行隔离），为 DSH 带来 `ctx_*` 工具、`/ctx-*` 命令、知识注入（m0/m1）、historian/dreamer 与 Magic 压缩策略。

> 本包为 [cortexkit/magic-context](https://github.com/cortexkit/magic-context) 单仓单包形态（MIT）。  
> **致谢：** 原社区移植来自 [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context)，本包为其延续，`adapter-api` 已合并，不再单独发布。

- **共享存储。** 单 SQLite `~/.local/share/cortexkit/magic-context/context.db`，`harness='dsh'` 隔离，与 OpenCode（`opencode`）和 Pi（`pi`）共存。
- **完整能力。** `ctx_reduce` / `ctx_expand` / `ctx_memory` / `ctx_search` / `ctx_note`，`/ctx-status` / `/ctx-recomp` / `/ctx-wrapup` / `/ctx-embed`，auto-search、`§N§` 标签、衰减渲染、smart-drops。
- **DSH 原生。** Host（`cordis` bundle）、Agent（`magic-standard` thin preset）、Client（状态卡），支持 `link:` 本地开发。

```sh
# 以 web（生产）/ mc（开发）为例
dsh plugin --profile web install link:/path/to/magic-context/packages/dsh-plugin
dsh-magic-context setup --profile web   # 生成 magic-standard 预设
dsh-magic-context doctor --profile web  # 5/5 ok（liveness 警告可忽略）
# 重启 DSH 并选择 magic-standard
```

## 安装

**生产（已发布）：**

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

```sh
dsh plugin --profile <name> install
dsh-magic-context setup --profile <name>
dsh-magic-context doctor --profile <name>
```

**本地开发（单仓）：**

```sh
bun run --cwd packages/dsh-plugin build
dsh plugin --profile <name> install link:/absolute/path/to/magic-context/packages/dsh-plugin
dsh-magic-context setup --profile <name>
# 全局预设指向 file:///…/magic-context/packages/dsh-plugin/dist/entries/*
# 多 profile 共享同一 file://，无漂移
```

重启 DSH，新会话选择 `magic-standard`。首次会话自动创建共享 SQLite。

## 功能

- **知识：** m0/m1 基线注入（项目文档 + 记忆）、auto-search、`§N§` 标签与 Channel-1/2 提醒
- **上下文：** DSH transcript + surface CAS（outbox saga）、historian 分区（分级衰减）、Magic 压缩策略
- **自动化：** Dreamer 任务、`/ctx-recomp` / `/ctx-wrapup` / `/ctx-session-upgrade`、`/ctx-embed`、feedback 桥接
- **Web：** 侧边状态卡 + Remote 诊断（`src/client/client.js`，`__ModuleLoader__` id `@cortexkit/dsh-magic-context`）

完整对照与约束见仓库 `README.md` 与 `ARCHITECTURE.md`。

## 卸载

```sh
dsh plugin --profile <name> remove @cortexkit/dsh-magic-context
```

移除 `bundles` 后重启 DSH。共享 SQLite 与 `dsh_*` 适配数据有意保留（跨 harness）；不再需要时手动删除 `~/.dsh/.agent-presets/magic-standard/`。

## 兼容

- DSH `0.1.1-rc.2` 精确匹配（升级前先跑 `doctor` 契约门）
- Magic Context 共享 schema `v81`

## 问答

**问：同时用 Pi / OpenCode 和 DSH 并想共享 memory，版本需要一致吗？**

需要。所有 harness 共用同一 SQLite `~/.local/share/cortexkit/magic-context/context.db`，库有版本（当前 `schema v81`，即 `LATEST_SUPPORTED_VERSION`）。新版本会前向迁移 DB，旧版本会因 schema fence 拒绝打开而 fail-closed。如需跨 `pi` / `opencode` / `dsh` 共享记忆，请保持 `@cortexkit/*-magic-context` 版本同步（同一 monorepo tag），以保证 schema 一致。`doctor` 会报告当前 schema 与适配上限。

**问：版本不一致会怎样？**

旧 harness 直接 fail-closed（显式报错，不会静默回退），DB 本身不会损坏；升级落后插件后即可重新打开并完成迁移。

## 致谢

原 DSH 移植：[xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context)。本包为其在上游单仓的延续，问题与 PR 请提至 [cortexkit/magic-context](https://github.com/cortexkit/magic-context)。

## 许可证

MIT。上游版权声明见 `THIRD_PARTY_NOTICES.md`。
