<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.it.md">Italiano</a> |
  <a href="./README.da.md">Dansk</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.pl.md">Polski</a> |
  <a href="./README.ru.md">Русский</a> |
  <a href="./README.bs.md">Bosanski</a> |
  <a href="./README.ar.md">العربية</a> |
  <a href="./README.no.md">Norsk</a> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*这是社区翻译。英文 [README.md](./README.md) 是权威来源，内容可能更新。*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>无限上下文。会自我管理的记忆。一个会话，伴随一生。</strong><br>
  CortexKit 的一部分，面向编码代理的海马体。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context?label=cli&color=orange&style=flat-square" alt="npm @cortexkit/magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?label=opencode&color=blue&style=flat-square" alt="npm @cortexkit/opencode-magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/pi-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/pi-magic-context?label=pi&color=purple&style=flat-square" alt="npm @cortexkit/pi-magic-context"></a>
  <a href="https://discord.gg/DSa65w8wuf"><img src="https://img.shields.io/discord/1488852091056295957?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
  <a href="https://github.com/cortexkit/magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <em>你不会为一个任务雇来开发者，交付后马上解雇。<br>也别这样对待你的代理。</em>
</p>

<p align="center">
  <a href="#什么是-magic-context">什么是 Magic Context？</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#cortexkit-的一部分">CortexKit</a> ·
  <a href="#上下文管理">上下文</a> ·
  <a href="#捕获">捕获</a> ·
  <a href="#巩固">巩固</a> ·
  <a href="#回忆">回忆</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## 什么是 Magic Context？

你不会雇一个开发者只修一个 bug，然后在它刚发布时立刻解雇。优秀的人你会留下。他们会学习代码库，记住当初为什么做出那些决定，并且每一周都更敏锐。

编码代理的工作方式正好相反。每个任务都是一次没有项目记忆的新入职，到了会话结束你又把它解雇，从零开始。任务中途它们还会遇到“压缩”暂停，流程被打断，已经知道的东西也会悄悄丢失。这就是顺行性遗忘，和海马体受损时发生的事情一样。

Magic Context 给它们补上这一部分。它是编码代理的**海马体**，也就是大脑中形成记忆、巩固记忆、再把记忆唤回的部分，而且完全在后台完成。一个会话不再是一次性承包商，而会变成长期队友，陪伴整个项目：

- **捕获。** 当 historian 压缩你的历史时，它会把持久知识（决策、约束、约定）提升到项目记忆中。你从已经在做的工作里免费得到一套记忆系统。
- **巩固。** 夜间，dreamer 代理会做睡眠为你做的事：对照代码库验证记忆，整理重复和过时条目，并提升反复出现的内容。
- **回忆。** 正确的记忆会在每一轮自动浮现，代理也可以按需搜索记忆、过去对话和 git 历史。跨会话，也跨 OpenCode 和 Pi。

两个承诺：你的代理**永远不会停下来管理上下文**（没有压缩暂停，没有中断的流程），并且它**永远不会忘记**。

为每个项目运行一个会话，并让它持续数周、数月或数年。它会记住你们一起构建的一切。

---

## 快速开始

运行交互式安装向导。它会检测你的模型，配置所有内容，并处理兼容性。

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**或直接运行（任何 OS）：**
```bash
npx @cortexkit/magic-context@latest setup
```

向导会自动检测你拥有的 harness（OpenCode、Pi，或两者），添加插件，关闭内置压缩，帮助你为 historian 和 dreamer 选择模型，并解决与其他上下文管理插件的冲突。用 `--harness opencode` 或 `--harness pi` 指定某个 harness。

> **为什么关闭内置压缩？** Magic Context 自己管理上下文。宿主的压缩会干扰它的缓存感知延迟操作，并造成双重压缩。

**手动设置**（OpenCode）：在 `opencode.json` 中添加插件并关闭压缩，然后把 `magic-context.jsonc` 放到 `<project>/.cortexkit/`（或把用户级默认配置放到 `~/.config/cortexkit/`）。参见[配置参考](./CONFIGURATION.md)。

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi`（需要 Pi `>= 0.74.0`）。Pi 扩展与 OpenCode 共享同一个数据库，项目记忆和嵌入会在两者之间汇集。

**故障排查：** `npx @cortexkit/magic-context@latest doctor` 会自动检测你的 harness，检查冲突（压缩、OMO hooks、DCP），验证插件和 TUI 侧边栏，对数据库运行完整性检查，并尽力修复。添加 `--issue` 可生成可直接提交的 bug 报告。

无论是全新项目还是长期运行的项目，工作方式都相同：安装，重启 harness，然后 Magic Context 从那一刻开始捕获上下文。它不会回填安装之前的 OpenCode 或 Pi 会话。

<details>
<summary><strong>与其他上下文管理插件的兼容性</strong></summary>

<br>

Magic Context 端到端拥有上下文管理，因此如果另一个插件已经在做这件事，它会**禁用自身**。同时运行两个上下文管理器会把你的历史双重压缩，并扰乱提示缓存。启动时它会检查以下项目；setup 和 `doctor` 会帮助你逐项解决。在解决之前，Magic Context 会保持关闭（故障安全）并告诉你原因：

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context 会替代它。Setup 会将它关闭。
- **DCP** (`opencode-dcp`): 一个单独的上下文剪枝插件。两者不能一起运行，请从你的 `plugin` 列表中移除它。
- **oh-my-opencode (OMO)**: setup 会提议关闭三个重叠的 hooks：
  - `preemptive-compaction`: 触发与 historian 冲突的压缩。
  - `context-window-monitor`: 注入与 Magic Context 提示重叠的用量警告。
  - `anthropic-context-window-limit-recovery`: 触发绕过 historian 的紧急压缩。

随时运行 `npx @cortexkit/magic-context@latest doctor` 重新检查并自动修复。

</details>

---

## CortexKit 的一部分

大脑不是一个器官。强大的编码代理也不是。

**CortexKit** 是一个插件家族，每个插件都以大脑的不同区域为模型。安装一个，你的代理就会更敏锐。三个都安装，它就有了一颗大脑。

| 插件 | 区域 | 作用 |
|---|---|---|
| **Magic Context** *（你在这里）* | 海马体和内侧颞叶 | 自我管理的上下文和长期记忆。它在形成、巩固并回忆跨会话的项目知识时，让会话持续运行且没有压缩暂停。 |
| **[AFT](https://github.com/cortexkit/aft)** | 感觉运动皮层 | 感知代码结构并精确行动。给你的代理一个真正的 IDE 和 OS。 |
| **Alfonso** *（即将推出）* | 前额叶皮层 | 执行控制。规划、拆解工作、选择代理和模型，并决定何时询问、验证和提交。 |

Magic Context 是**你将永远需要的 3 个插件之一。** 它负责记忆；AFT 负责感知和行动；Alfonso 负责决策。它们共享一个 CortexKit 存储，因此记忆会跨 harness 和工具汇集。

---

## ⚡ 上下文管理

*会自我管理的无限会话。* 工作时，上下文窗口会逐渐填满，而通常的修复方式，压缩，会让代理停下来重新阅读所有内容。Magic Context 持续在后台处理，所以会话会继续向前。

- **Historian 分区**：后台 historian 会把旧的原始历史压缩成**分层分区**，也就是按时间排列、可代替旧消息的摘要。每个分区都有重要性分数，因此实时窗口保持很小，同时不会丢失线索。摘要不需要主代理的编码能力，所以你可以用便宜的模型，甚至完全本地的模型来运行 historian，同时让主代理保持顶级水平。
- **衰减渲染**：分区会以当下合适的保真度渲染，规则是确定性的，不使用 LLM，并会根据模型的上下文窗口自我调节。旧历史会优雅淡出，而不是从悬崖上掉下去。因为它是确定性的，相同历史总会以相同方式渲染。
- **代理提示该丢什么，或者不提示**：启用代理驱动的缩减时，代理会调用 `ctx_reduce` 标记过时的工具输出或长消息以便移除。丢弃会**排队并感知缓存**，只在缓存安全的时刻应用，所以缩减不会扰乱缓存。关闭它后，代理完全不参与上下文管理：过时输出会按年龄自动脱落，也可以对最旧文本使用可选的 caveman 压缩。
- **缓存稳定布局**：所有这些都被组织成后台工作永远不会使提示的缓存前缀失效。你的缓存会贯穿整个会话。

结果是：一个会话可以运行数月，没有压缩暂停，并且在按缓存计价的提供商上成本很低。你可以在 OpenCode 的 TUI 中观察这一切，实时侧边栏会显示按来源划分的上下文、historian 状态和记忆数量，并在每条消息后更新。

> *可选（默认关闭）：* **caveman text compression** 会按照确定性的年龄分层规则，逐步压缩最旧的用户和助手文本，适用于关闭代理驱动缩减的长时间会话。

---

## 🧠 捕获

*免费的记忆。* 为了压缩你的历史，historian 必须读取全部历史。因此在同一次遍历中，它会抽取值得永久保留的知识：决策、约束、约定、配置值，并提升到**项目记忆**中，分类后带入每个未来会话。你的记忆会从你已经在做的工作里自己构建起来。

代理也可以显式记录记忆，虽然大多数记忆会自动为它捕获：

- **`ctx_memory`**：直接写入或删除跨会话知识，使用一个小型类别分类法（`PROJECT_RULES`、`ARCHITECTURE`、`CONSTRAINTS`、`CONFIG_VALUES`、`NAMING`）。

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **时间感知** *（默认开启）* 让代理拥有时间感，在消息之间使用类似 `+2h 15m` 的间隔标记和带日期的分区，所以它能推理某件事发生在多久以前。设置 `temporal_awareness: false` 可关闭。

---

## 🌙 巩固

*睡眠为记忆所做的事。* 可选的 **dreamer** 代理会在夜间运行，以保持记忆质量，并为每个任务启动临时子会话：

- **验证**：增量检查记忆是否符合当前代码库（路径、配置、模式），并修复或移除过时事实。
- **整理**：扫描整个记忆池，合并重复项，收紧措辞，并归档低价值或冗余条目。
- **分类**：在不扰动实时提示缓存的情况下，为每条记忆的重要性、范围和安全共享性打分。
- **维护文档**：根据代码库变化保持 `ARCHITECTURE.md` 和 `STRUCTURE.md` 最新。
- **用户记忆**：把关于你工作方式的重复观察（沟通风格、评审重点、工作模式）提升到会随每个会话移动的 `<user-profile>` 中。
- **智能笔记**：评估 `surface_condition` 已经成真的延迟笔记，并浮现准备好的那些。

因为它在空闲时间运行，dreamer 很适合搭配本地模型，即使模型很慢也可以。没有人在等待。随时用 `/ctx-dream` 触发一次运行。

---

## 🔎 回忆

*在正确时刻出现的正确记忆。* 每一轮，活动的项目记忆和压缩后的会话历史都会自动、缓存稳定地注入。按需时，代理会使用：

- **`ctx_search`**：一次查询同时跨三层：项目**记忆**、原始**对话**历史，以及已索引的 **git commits**。语义嵌入，并带全文回退。

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**：当代理需要确切细节时，把某段压缩历史范围还原成原始 `U:`/`A:` transcript。
- **`ctx_note`**：用于延迟意图的草稿板。笔记会在自然边界重新浮现（提交之后、historian 运行之后、todos 完成时）。**Smart notes** 带有开放式条件，由 dreamer 观察。

回忆可以**跨会话**工作（新会话继承一切），也可以**跨 harness** 工作（在 OpenCode 写入记忆，在 Pi 中取回）。

> **自动搜索提示** *（默认开启）* 每一轮都会在后台运行一次 `ctx_search`，当有相关内容存在时轻声给出“模糊回忆”，就像差点想起你记下过的一条笔记。它只追加紧凑片段，绝不追加完整内容；设置 `memory.auto_search.enabled: false` 可关闭。**Git commit 索引** *（选择开启）* 会让你的项目历史作为第四个 `ctx_search` 来源可被语义搜索，使用 `memory.git_commit_indexing.enabled: true` 启用。

### 代理工具一览

| 工具 | 部分 | 作用 |
|------|-------|-------------|
| `ctx_reduce` | 上下文 | 将过时的已标记内容排队等待移除，并感知缓存 |
| `ctx_memory` | 捕获 | 写入或删除持久的跨会话记忆 |
| `ctx_search` | 回忆 | 搜索记忆、对话历史和 git commits |
| `ctx_expand` | 回忆 | 将一段历史范围解压回 transcript |
| `ctx_note` | 回忆 | 延迟意图和由 dreamer 评估的 smart notes |

---

## 命令

| 命令 | 描述 |
|---------|-------------|
| `/ctx-status` | 调试视图：tags、待处理丢弃、缓存 TTL、提示状态、historian 进度、分区覆盖、历史预算 |
| `/ctx-flush` | 立即强制执行所有排队操作，绕过缓存 TTL |
| `/ctx-recomp` | 从原始历史重建分区（接受 `start-end` 范围）。当存储状态看起来不对时使用 |
| `/ctx-dream` | 按需运行 dreamer 维护：维护记忆、文档、smart notes，并审查 user-profile |

---

## 桌面应用

一个配套桌面应用，用于在终端之外浏览和管理 Magic Context 状态。

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **记忆浏览器**：按类别和项目搜索、过滤并编辑项目记忆。
- **会话历史**：通过时间线导航浏览任意会话的分区和笔记。
- **缓存诊断**：实时缓存命中/未命中时间线和破坏原因检测。
- **Dreamer 管理**：查看 dream-run 历史，触发运行，检查任务结果。
- **配置编辑器**：以表单方式编辑每个设置，包括模型回退链。
- **日志查看器**：带搜索的实时日志跟踪。

它直接读取 Magic Context 的 SQLite 数据库。不需要额外服务器，也不需要 API。内置自动更新。

---

## 配置

设置位于 `magic-context.jsonc`。所有内容都有合理默认值；项目配置会叠加到用户级设置之上。完整参考，包括缓存 TTL 调优、按模型设置的 execute 阈值、historian 和 dreamer 模型选择、嵌入提供商以及记忆设置，请参见 **[CONFIGURATION.md](./CONFIGURATION.md)** 或 **[docs.cortexkit.io 上的配置参考](https://docs.cortexkit.io/magic-context/reference/configuration/)**。

**配置位置**（一个共享的 CortexKit 位置，项目覆盖用户）：
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

从早期版本升级？你的现有配置会在首次运行时自动移动到这里（旧路径会留下一个 `.MOVED_READPLEASE` 面包屑）。

---

## 存储

所有持久状态都位于共享 CortexKit 存储下的本地 SQLite 数据库中（`~/.local/share/cortexkit/magic-context/context.db`，Windows 上使用 XDG 等价位置；旧的 OpenCode 文件夹数据库会在首次启动时迁移）。如果数据库无法打开，Magic Context 会禁用自身并通知你。记忆绑定到从 repo 派生的**稳定项目身份**，因此它们会随着项目跨 worktrees、clones 和 forks 移动，而不是绑定到目录路径。

Magic Context 还会写入少数其他位置：

| 路径 | 内容 | 持久性 |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite 数据库，tags、分区、记忆和所有持久状态（Windows 上使用 XDG 等价位置） | **必须持久。** 丢失它就会丢失你的记忆/历史。 |
| `~/.local/share/cortexkit/magic-context/models/` | 本地嵌入模型缓存（约 90 MB `Xenova/all-MiniLM-L6-v2` ONNX），启用本地嵌入时首次使用会下载 | 应该持久，否则每次运行都会重新下载。配置 `memory.enabled: false` 或 `openai_compatible`/`ollama` 嵌入后端时不使用。 |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | 诊断日志 | 可丢弃。 |

**沙盒化 / 临时环境（Docker、CI、一次性容器）：** 将 `~/.local/share/cortexkit/magic-context/` 目录挂载到持久卷上，让数据库和模型缓存能在运行之间保留。如果只有模型缓存是临时的，模型只会重新下载；如果数据库是临时的，记忆和历史不会累积。若要完全避免约 90 MB 的模型下载，请设置 `memory.enabled: false` 或将 `embedding` 指向远程 `openai_compatible`/`ollama` 后端。

---

## 星标历史

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## 开发

**要求：** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream 执行需要一个正在运行的 OpenCode 服务器（dreamer 会创建临时子会话）。在 OpenCode 中使用 `/ctx-dream` 进行按需维护。

---

## 贡献

欢迎 bug 报告和 pull requests。对于较大的更改，请先打开 issue 讨论方案。提交前运行 `bun run format`；CI 会拒绝未格式化的代码。

---

## 许可证

[MIT](LICENSE)
