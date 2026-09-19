# @cortexkit/dsh-magic-context

DeepSeek Harness (DSH) 上的 Magic Context — 长编码会话始终在上下文窗口内，且不丢失历史。本该撑爆窗口的会话可以一直跑下去：模型学到的所有东西（持久记忆、分段摘要、可搜索的原始历史）依然可达。

以原生 DSH 插件形态安装，对**所有 agent preset** 生效——无需任何 preset 级配置。`ctx_*` 工具、`/ctx-*` 命令、知识注入、historian/dreamer 与 Magic 压缩策略全部 host 平面挂载。

> 本包为 [cortexkit/magic-context](https://github.com/cortexkit/magic-context) 单仓单包形态（MIT）。  
> **致谢：** 原社区移植来自 [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context)，本包为其延续，`adapter-api` 已合并，不再单独发布。

- **共享存储。** 单 SQLite `~/.local/share/cortexkit/magic-context/context.db`，`harness='dsh'` 隔离，与 OpenCode、Pi 共存，无需额外数据库，跨 harness 记忆直接可用。
- **完整能力。** `ctx_reduce` / `ctx_expand` / `ctx_memory` / `ctx_search` / `ctx_note`，`/ctx-status` / `/ctx-recomp` / `/ctx-wrapup` / `/ctx-embed`，auto-search、`§N§` 标签、衰减渲染、smart-drops。
- **DSH 原生，零配置挂载。** Host（`cordis` bundle）+ Agent（host 平面行，每个 preset）+ Client（状态卡）。启动自愈**原地改写** shipped presets 的压缩行（ADR 0001）——重启 DSH 即完成挂载。

```sh
# 以 web（生产）/ mc（开发）为例
dsh plugin --profile web install link:/path/to/magic-context/packages/dsh-plugin
# 重启 DSH：每个 preset 都获得 Magic 表面；状态面板的 preset 行显示
# "patched 3/3" 即 shipped presets 补丁到位
```

## 安装

**生产 — npm（已发布后）：**

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

```sh
dsh plugin --profile <name> install
dsh-magic-context doctor --profile <name>
```

**生产 — GitHub 子路径（未发 npm 时，已用 pnpm 11 验证）：**

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "github:haoliangwu/magic-context#master&path:packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

```sh
dsh plugin --profile <name> install
# 若 dist/ 缺失（git 拉取未含构建产物），在已安装包内手动构建一次：
pnpm --filter @cortexkit/dsh-magic-context run build
# 或：pnpm --cwd ~/.dsh/profiles/<name>/node_modules/@cortexkit/dsh-magic-context run build
# （prepare 尝试 pnpm run build；底层仍需 bun）
dsh-magic-context doctor --profile <name>
```

> 已验证：`pnpm add "@cortexkit/dsh-magic-context@github:haoliangwu/magic-context#master&path:packages/dsh-plugin"` 可解析（170 包）。`prepare` 会尝试 `bun run build`，若 profile 无 `bun` 则按上一行手动构建。

**本地开发（单仓）：**

```sh
bun run --cwd packages/dsh-plugin build
dsh plugin --profile <name> install link:/absolute/path/to/magic-context/packages/dsh-plugin
# 重启 host：启动自愈（ADR 0001）从本包模块上下文解析
# @deepseek-ai/dsh-agent-presets，把 shipped 的 compaction-basic 行改写为
# file://…/dist/entries/compaction.js（tmp+rename 原子写；绝不原地写 pnpm 硬链接）
```

重启 DSH — 每个 preset 都能以 host 平面挂载 Magic 表面；shipped presets 的压缩行指向 `file://…/magic-context/packages/dsh-plugin/dist/entries/compaction.js`。首次会话自动创建共享 SQLite。`setup` 是 doctor 的只读报告别名。

## 功能

- **知识：** m0/m1 基线注入（项目文档 + 记忆）、auto-search、`§N§` 标签与 Channel-1/2 提醒
- **上下文：** DSH transcript + surface CAS（outbox saga）、historian 分区（分级衰减）、Magic 压缩策略
- **自动化：** Dreamer 任务、`/ctx-recomp` / `/ctx-wrapup` / `/ctx-session-upgrade`、`/ctx-embed`、feedback 桥接
- **Web：** 侧边状态卡 + Remote 诊断（`src/client/client.tsx` → `dist/client.js`，`__ModuleLoader__` id `@cortexkit/dsh-magic-context`）

完整对照与约束见仓库 `README.md` 与 `ARCHITECTURE.md`。

## 卸载

```sh
dsh plugin --profile <name> remove @cortexkit/dsh-magic-context
```

移除 `bundles` 后重启 DSH。共享 SQLite 与 `dsh_*` 适配数据有意保留（跨 harness）；遗留的 `~/.dsh/.agent-presets/magic-standard/` thin preset 由启动自愈先做形状校验再删除。移除后 shipped presets 的已改写行会指向不存在的路径，直到 preset 文件轮换（ADR 0001 —— 单用户部署下可接受；`doctor` 会报告该状态）。

## 兼容

- DSH `0.1.5-rc.2`（升级前先跑 `doctor` 契约门；布局变化时启动自愈的锚点链 fail-open）
- Magic Context 共享 schema `v84`

## 问答

**问：同时用 Pi / OpenCode 和 DSH 并想共享 memory，版本需要一致吗？**

需要。所有 harness 共用同一 SQLite `~/.local/share/cortexkit/magic-context/context.db`，库有版本（当前 `schema v84`，即 `LATEST_SUPPORTED_VERSION`）。新版本会前向迁移 DB，旧版本会因 schema fence 拒绝打开而 fail-closed。如需跨 `pi` / `opencode` / `dsh` 共享记忆，请保持 `@cortexkit/*-magic-context` 版本同步（同一 monorepo tag），以保证 schema 一致。`doctor` 会报告当前 schema 与适配上限。

**问：版本不一致会怎样？**

旧 harness 直接 fail-closed（显式报错，不会静默回退），DB 本身不会损坏；升级落后插件后即可重新打开并完成迁移。

## 致谢

原 DSH 移植：[xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context)。本包为其在上游单仓的延续，问题与 PR 请提至 [cortexkit/magic-context](https://github.com/cortexkit/magic-context)。

## 许可证

MIT。上游版权声明见 `THIRD_PARTY_NOTICES.md`。
