# Extension landscape survey: how agent harnesses let plugins extend a session

Purpose: inform the design of CK's module and plugin surface. Research only; no code was changed.

Date of survey: 2026-09-25.

## Sources and snapshots

| Host | Source used | Snapshot |
|---|---|---|
| OpenCode 1.x | `~/Work/OSS/opencode`, tag `v1.18.32` (commit `545f51d2`, 2026-09-21), read with `git show v1.18.32:<path>` | last 1.x release in the clone |
| OpenCode 2.x | same clone, checked-out `HEAD` `5716f8ba60` (2026-09-03); tags up to `v2.0.15` exist | 2.0 is labelled beta in its own docs |
| Pi | `~/Work/OSS/pi-mono` (remote `badlogic/pi-mono`, `e005a4e7e`, 2026-09-24, package `@earendil-works/pi-coding-agent` 0.87.1). `~/Work/OSS/pi` (remote `earendil-works/pi`, `29b3417a7`, 2026-05-18, 0.75.3) is an older snapshot of the same code base, so this report cites pi-mono. | |
| Oh My Pi (omp) | `~/Work/OSS/oh-my-pi` (remote `can1357/oh-my-pi`, `21659c1feb`, 2026-09-23, 18.2.11) | |
| Claude Code | official docs at `code.claude.com/docs/en/*`, fetched 2026-09-25 | |
| Codex CLI | `~/Work/OSS/codex` (remote `openai/codex`, `7498521d28`, 2026-09-18) | |
| Plugin catalogues | OpenCode `ecosystem.mdx` (v1.18.32), `pi.dev/packages`, `anthropics/claude-plugins-official`, local clones of plugins under `~/Work/OSS` | |
| Pain points | GitHub issue search API over `anomalyco/opencode`, `earendil-works/pi`, `anthropics/claude-code`, `openai/codex` (sorted by reactions; "+N" = reaction count at fetch time) | |

Citation style: `repo:path:line` for source; URLs for web. Statements marked **Inference** are mine; everything else is what the cited source says.

---

## 1. OpenCode 1.x

### 1.1 Loading model and plugin context

- A plugin is a JS/TS module exporting functions `(input, options) => Promise<Hooks>` (`opencode@v1.18.32:packages/plugin/src/index.ts:74`). `PluginInput` carries `client` (SDK client), `project`, `directory`, `worktree`, `experimental_workspace`, `serverUrl`, plus Bun's `$` shell (`packages/plugin/src/index.ts:56-66`; docs `packages/web/src/content/docs/plugins.mdx:67-123`).
- Sources: npm packages in `opencode.json` `plugin: [...]` (installed with Bun at startup into a cache), `.opencode/plugins/`, `~/.config/opencode/plugins/`. Load order: global config, project config, global dir, project dir; "all hooks run in sequence" (`plugins.mdx:12-63`). Built-in auth plugins (`CodexAuthPlugin`, `CopilotAuthPlugin`) load first unless disabled (`packages/opencode/src/plugin/index.ts:67-74, 170`).
- Chaining: `Plugin.trigger(name, input, output)` loops over every loaded plugin's hook in load order, awaits each, and returns the same mutated `output` object (`packages/opencode/src/plugin/index.ts:284-297`). There are no priorities, no per-plugin error isolation beyond logging, and no way for a plugin to see what an earlier plugin changed except by reading the shared object.
- Trust: plugins run in the OpenCode process with full Bun access (`$`, filesystem, network). The docs describe no sandbox or permission model for plugin code (`plugins.mdx:67-123`).

### 1.2 What a plugin can do (Hooks interface, `packages/plugin/src/index.ts:222-335`)

| Capability | Hook | Where the host calls it | When |
|---|---|---|---|
| Add tools | `tool: { [name]: ToolDefinition }` (`:226-228`); also `.opencode/tools/*.ts` files (`custom-tools.mdx:16-20`) | tool registry | startup |
| Rewrite tool definitions sent to the model | `tool.definition` (`:334`) | `packages/opencode/src/tool/registry.ts:318` | each time tools are resolved for a request |
| Change the system prompt | `experimental.chat.system.transform` `{system: string[]}` (`:291-296`) | `session/llm/request.ts:69-77`; also agent generation `agent/agent.ts:381` | **per LLM request** |
| Reshape history before a model call | `experimental.chat.messages.transform` `{messages: {info, parts}[]}` (`:282-290`) | `session/prompt.ts:1255` (inside the step loop); `session/compaction.ts:379` (on the compaction input) | **per LLM request** (every loop step) and on compaction |
| Rewrite the user message | `chat.message` `{message, parts}` (`:234-243`) | `session/prompt.ts:999` | once per user message (persisted) |
| Model parameters and headers | `chat.params` (temperature, topP, topK, maxOutputTokens, provider options) and `chat.headers` (`:247-260`) | `session/llm/request.ts:114, 134` | per LLM request |
| Intercept tool calls | `tool.execute.before` `{args}` (mutable) (`:266-269`) | `session/tools.ts:106-420`, task tool `session/prompt.ts:307` | per tool call |
| Rewrite tool results | `tool.execute.after` `{title, output, metadata}` (`:274-281`) | same files, `prompt.ts:389` | per tool call |
| Shell environment | `shell.env` (`:270-273`) | `tool/shell.ts:417`, `session/prompt.ts:554`, `plugin/pty-environment.ts:18` | per shell spawn |
| Supplement or replace compaction | `experimental.session.compacting` `{context: string[], prompt?}`: append context or replace the compaction prompt (`:298-308`); `experimental.compaction.autocontinue` `{enabled}` (`:316-326`) | `session/compaction.ts:373, 500` | per compaction |
| Rewrite finished assistant text | `experimental.text.complete` (`:327-330`) | `session/processor.ts:530` | per text part |
| Providers, models, auth | `auth: AuthHook` (OAuth/API methods, loader) (`:88-164, 229`), `provider: ProviderHook` with `models()` (`:214-219, 230`), `experimental.provider.small_model` (`:297`) | `provider/provider.ts:1953` | startup / provider resolution |
| Commands | No command registration hook. `command.execute.before` `{parts}` can rewrite a command's prompt parts (`:262-265`, called at `session/prompt.ts:1460`). Commands themselves are Markdown/JSON config (`commands.mdx:16-89`). Plugins add commands or agents by mutating the config object in the `config` hook (the issue asking whether this is supported: [#24065](https://github.com/anomalyco/opencode/issues/24065)). | | startup |
| Observe events | `event({event})` (`:224`) | bus | continuous |
| Read/patch config | `config(cfg)` (`:225`), called after load (`plugin/index.ts:245`) | | startup |
| Permissions | `permission.ask` `{status: ask/deny/allow}` is declared (`:261`) but **has no call site** in `v1.18.32` (`git grep` finds no trigger). Open reports: [#7006](https://github.com/anomalyco/opencode/issues/7006) (+26), [#9229](https://github.com/anomalyco/opencode/issues/9229), [#47674](https://github.com/anomalyco/opencode/issues/47674); unmerged PRs [#19453](https://github.com/anomalyco/opencode/pull/19453), [#30509](https://github.com/anomalyco/opencode/pull/30509), [#47675](https://github.com/anomalyco/opencode/pull/47675). | — | never |
| UI | Server plugins have no UI surface; 1.x declares a separate `tui` module kind (`PluginModule.tui`, `:76-80`). | | |

### 1.3 Prompt-cache protection in 1.x

- The system prompt is built as one string (`request.ts:56-66`). After `system.transform`, if a plugin pushed extra entries and left `system[0]` unchanged, the host rejoins everything after the header into a second string, so the request has at most two system blocks: a stable header and a variable tail (`request.ts:68-77`).
- Cache markers are applied **after** all plugin transforms: `applyCaching` marks the first two system messages and the **last two non-system messages** (`packages/opencode/src/provider/transform.ts:358-383`, invoked at `:476-483` for Anthropic-family models).
- There is no protection against a plugin editing older history in `messages.transform`. Any edit before the last cached breakpoint changes the prefix. **Inference:** the cache survives only if plugins edit history deterministically, every turn.
- Appending is also unsafe: [#43507](https://github.com/anomalyco/opencode/issues/43507) (open) measured that a plugin notice appended by `messages.transform` takes one of the two tail breakpoints, and "that breakpoint can never produce a cache hit". Two appended notices remove the cached prefix entirely. Cache reads stayed flat at 300,150 while writes grew to 25,074 over four requests.

### 1.4 Agents, subagents, modes

- Agents have `mode: primary | subagent | all`, `model`, `prompt`, `permission` (which is also how tool access is set), `temperature`, and so on. They are defined in JSON config or Markdown (`opencode@v1.18.32:packages/web/src/content/docs/agents.mdx:16-41, 142-199`).
- Commands can pin `agent`, `model`, and `subtask` (`commands.mdx:16-89`).
- Hook inputs carry `agent` for `chat.params` and `chat.headers` only (`index.ts:247-260`). `system.transform` gets `sessionID` and `model`, not the agent (`:291-293`), so per-agent behaviour in that hook needs the plugin to track state itself. Requests: [#6142](https://github.com/anomalyco/opencode/issues/6142) (sessionID for system.transform), [#15403](https://github.com/anomalyco/opencode/issues/15403) (parentAgent identity).

---

## 2. OpenCode 2.x (beta)

"V1 plugins will not work in V2 … plugin implementation code must be ported to the new API" (`opencode:packages/www/src/docs/content/migrate-v1.mdx:513-548`). The config key is renamed from `plugin` to `plugins`, and the config normaliser maps the old entries (`packages/core/src/config/normalize.ts:179-184`).

### 2.1 Loading model and context

- A plugin is `Plugin.define({ id, setup(ctx) })` (Promise API) or `{ id, effect(ctx) }` (Effect API) (`packages/plugin/src/effect/plugin.ts:52-59`; docs `packages/www/src/docs/content/build/plugins/index.mdx:1-60`). `setup` may return a cleanup function. Duplicate plugin IDs are a fatal error (`packages/core/src/plugin.ts:73-76`).
- The injected `Context` is essentially a server client plus plugin-only editors: `app, location, options, agent, aisdk, catalog, command, event, integration, mcp, generate, permission, plugin, reference, rpc, session, shell, skill, storage (per-plugin KV), tool, vcs, websearch` (`packages/plugin/src/effect/plugin.ts:24-50`; built in `packages/core/src/plugin/host.ts:46-491`). `ctx.session` can create, prompt, fork, switch agent or model, run synthetic prompts, interrupt, and read `context` (`host.ts:465-491`).
- Loading: npm packages are installed, then imported in-process (`packages/core/src/plugin/module.ts:34-75`). Boot order is internal "pre" plugins, then SDK-contributed, then instance-bound plugins, then internal "post" plugins; "instance's explicit choices win over globals" (`packages/core/src/plugin/supervisor.ts:135-168`). The design plan fixes the order as built-ins, base data, config projections, provider normalisation, external user plugins, core finalisation (`packages/plugin/src/effect/PLAN.md:253-279`).
- Hot replacement: on re-activation only the unchanged prefix of the plugin list stays alive; every plugin after the first changed one is torn down and re-run, because "Registrations are ordered by setup, so only the unchanged prefix can stay alive" (`packages/core/src/plugin.ts:84-117`). Each plugin gets its own `Scope`. Closing the scope disposes all of its registrations (`plugin.ts:43-65`; `effect/README.md:8-25`).

### 2.2 Two kinds of extension point

**Transforms** are synchronous, replayable edits to a registry. "the next read rebuilds it by replaying every active transform in registration order onto a fresh value", and a later plugin can override or remove what earlier plugins added (`build/plugins/index.mdx:118-202`). Domains: `agent, catalog (providers/models), command, integration, mcp, reference, skill, tool, vcs, websearch` (`effect/README.md:26-60`).

**Runtime hooks** intercept live operations. They run "in plugin order, so later hooks see changes made by earlier hooks" (`index.mdx:1031-1042`). The hook domains are typed in `packages/core/src/plugin/hooks.ts:13-19`. Only `tool.execute.before` may fail: a `Tool.Error` rejects the call (`hooks.ts:23-31`; `effect/tool.ts:48-52`).

| Capability | 2.x mechanism | When |
|---|---|---|
| Add, rename, or remove tools | `ctx.tool.transform(editor => editor.add/update/remove/namespace)`. "Each model request captures a stable, executable tool snapshot" (`index.mdx:809-876`). | registry rebuild; snapshot per request |
| System prompt, history, tools, generation params | `ctx.session.hook("context", e => …)` with mutable `system: SystemPart[]`, `messages`, `tools`, `generation`, `providerOptions` (`effect/session.ts:21-31`). "Context changes affect only the outgoing model call, not persisted history". It runs for tool continuations, transient generation, and compaction, but not for titles (`index.mdx:1090-1118`; call site `packages/core/src/session/model-request.ts:314`; titles opt out `session/title.ts:72`). | **per model call** |
| Rewrite user input | `session.hook("prompt")`: mutable draft of text, files, agents, skills, delivery. "Edits become the canonical persisted user input". Runs once at admission (`index.mdx:1048-1088`; `core/src/session/prompt.ts:37-52`). | once per prompt (persisted) |
| Headers, HTTP, retry | `model.request`, `http.request`, `http.response`, `retry` hooks (`effect/session.ts:33-74`; `model-request.ts:219-371`) | per call |
| Tool interception | `tool.hook("execute.before" / "execute.after")`, input and result mutable (`effect/tool.ts:20-46`; `core/src/tool.ts:103-148`) | per tool call |
| Shell | `shell.hook("create.before")`: command, cwd, timeout, env (`index.mdx:1300-1325`; `core/src/shell.ts:268`) | per spawn |
| Compaction | **No dedicated compaction hook.** V2 compaction "reuses the normal instructions, tool definitions, and structured history prefix, then appends a user message requesting a checkpoint. Context hooks run as they do for normal session requests" (`packages/www/src/docs/content/compaction.mdx:80-83`). A PR adding compaction and generate hooks was closed ([#48212](https://github.com/anomalyco/opencode/pull/48212)). | — |
| Providers, models, auth | `catalog.transform`, `integration.transform` (auth methods), `aisdk.hook("sdk" / "language")` to swap AI-SDK instances (`effect/aisdk.ts:5-18`; `effect/README.md:62-90`) | registry / per model resolution |
| Commands | `command.transform(editor.add({name, execute}))` (`index.mdx:340-372`) | registry |
| Agents | `agent.transform(editor.update/remove/default)` (`index.mdx:206-236`) | registry |
| Skills, MCP, references | `skill.transform`, `mcp.transform`, `reference.transform` (`host.ts:391-418`) | registry |
| Events | `ctx.event.subscribe()` stream of server events (`host.ts:228-238`) | continuous |
| Permissions | `permission.hook("evaluate")`: runs for configured `allow` and `ask`, "An explicit configured `deny` is final", and the hook may set `effect` to allow, ask, or deny with a `message` (`index.mdx:1257-1298`; `core/src/permission.ts:174`) | per permission evaluation |
| UI | separate "CLI plugin" surface with events, sessions, dialogs and toasts, routes and tabs, slots, commands and keymaps, storage (`packages/www/src/docs/content/build/plugins/cli.mdx`, sections at lines 21-416) | TUI process |
| Cross-plugin RPC | `ctx.rpc`, with an optional `./rpc` export publishing a typed contract (`index.mdx:1362-1384`) | |

### 2.3 Prompt-cache handling in 2.x

- The host passes a stable `promptCacheKey` per session (the root session for forks) (`model-request.ts:212, 334-335`). The `context` hook runs before the request is lowered, so any cache breakpoints come after all plugin edits (`model-request.ts:314-341`).
- I found nothing in the plugin docs that tells plugin authors about cache stability, and nothing that detects prefix mutation. **Inference:** the 1.x risk remains. The `context` hook gets the whole `messages` array and every system part on every call, so a careless plugin can rewrite the prefix. #43507 says the native cache policy selects breakpoints by role and position in the same way ("we have not measured that route").

---

## 3. Pi (pi-mono, `@earendil-works/pi-coding-agent` 0.87.1)

### 3.1 Loading model

- An extension is a default-exported factory `(pi: ExtensionAPI) => void | Promise<void>` (`pi-mono:packages/coding-agent/src/core/extensions/types.ts:1715-1716`). It is loaded with `jiti`, so TypeScript runs without a build step (`docs/extensions.md:13-40`).
- Locations: `~/.pi/agent/extensions/`, `.pi/extensions/` (`docs/configuration.md:20, 32`), `--extension <path>`, and **Pi packages**, which are npm, git, or local directories bundling `extensions/`, `skills/`, `prompts/`, and `themes/`, declared under `pi` in `package.json` and installed with `pi install` (`docs/packages.md:1-90`). The `pi-package` keyword lists a package in the gallery at pi.dev/packages.
- Order: "Handlers run in extension load and registration order" (`docs/extensions.md` "Events and concurrency", about lines 93-100).
- Trust: project extensions, packages, and prompts load only after **project trust** is granted. Trust "does not sandbox tool calls", and extensions run with the Pi process's permissions (`docs/packages.md:13-21`; `docs/index.md:39`; `docs/security.md:3, 33`). Sandboxing is left to extensions (`examples/extensions/sandbox/`, `gondolin/`; `examples/extensions/README.md:15-30`).

### 3.2 What an extension can do

| Capability | API | When |
|---|---|---|
| Add tools | `pi.registerTool({name, description, parameters (TypeBox), execute})`; `setActiveTools()` activates or deactivates tools at runtime (`types.ts:1426, 1524`; docs "Tools" and "Activate tools dynamically") | startup, toggled at runtime |
| System prompt | `before_agent_start` gets `systemPrompt` and a mutable structured `systemPromptOptions` (sections, tools, guidelines), and may return a full `systemPrompt` replacement or add a custom `message` (`types.ts:737-748, 1253-1257`) | **once per user prompt**, before the agent loop |
| Reshape history before a model call | `context` gets the conversation without system messages. The handler may return or edit `messages`, and Pi restores the prompt and tool state afterwards. `context_with_system` sees and owns the full transcript (`types.ts:690-711`). Implementation: `runner.emitContext` works on a `structuredClone` of the messages each call (`src/core/extensions/runner.ts:1185-1245`). It is wired as `transformContext` for every model call (`src/core/sdk.ts:390-394`). | **per LLM call, ephemeral** (not persisted) |
| Raw provider payload and headers | `before_provider_request` (replace the payload), `before_provider_headers`, `after_provider_response` (`types.ts:714-735`) | per call |
| Tool calls | `tool_call`: mutate `event.input` in place or return `{block, reason, terminate}`. A handler failure blocks the tool (fail-closed) (`types.ts:1024-1038, 1217-1226`; docs "Errors and cleanup"). `tool_result` returns replacement `content`, `details`, `isError`, and handlers compose (`types.ts:1040-1106, 1241-1246`). | per tool call |
| Persisted-message rewrite | `message_end` may replace a finalised message, keeping its role (`types.ts:1248-1251`) | per message |
| Append entries or continue | `turn_end` and `agent_before_settle` may append `custom`, `custom_message`, `context_edit`, or `compaction` entries and request one more model request (`types.ts:762-822`; docs "Events and concurrency") | per turn / at settle |
| Compaction | `session_before_compact` may `cancel` or return a full `compaction` result (its own summary, `firstKeptEntryId`, details) (`types.ts:598-609, 1268-1271`; `docs/compaction.md:292`; example `examples/extensions/custom-compaction.ts:1-30`). `session_compact` and `session_compact_failed` report the outcome. `session_before_tree` does the same for branch summaries. | per compaction |
| Providers, models, auth | `pi.registerProvider(name, {baseUrl, api, models, oauth, streamSimple})`, applied immediately after load; `unregisterProvider` (`types.ts:1560-1620`) | startup or runtime |
| Commands and UI | `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerEntryRenderer`, `registerMarkdownTransformer` (`types.ts:1435-1476`). `ctx.ui` covers dialogs, notifications, status, widgets, custom footer, header, editor component, overlays, themes, and autocomplete (`types.ts:133-288`). | startup / interactive |
| Input | `input` returns continue, transform, or handled (`types.ts:951-967`); `user_bash` can replace `!` command execution | per input |
| Session and model control | `sendMessage` (custom message, optionally triggering a turn), `sendUserMessage`, `appendEntry` (persisted, **not** sent to the LLM), `setModel`, `setThinkingLevel`, session fork, tree, switch from commands (`types.ts:1483-1530, 355-393`) | runtime |
| Events | session_*, agent_*, turn_*, message_*, tool_execution_*, model_select, and more (`types.ts:549-967, 1169-1199`); inter-extension `pi.events` bus (`:1623`) | continuous |
| Cache | `cache_warming_decision`: override Pi's idle prompt-cache refresh with warm or stop, and the last handler wins (`src/core/cache-warmer.ts:100-130`; docs "cache_warming_decision") | on idle timer |
| Permissions | None built in. Policy is implemented in `tool_call` (examples `permission-gate.ts`, `protected-paths.ts`) | — |

### 3.3 Prompt-cache handling in Pi

- The prompt and tool set are recorded in the transcript's first system message. Later prompt and tool changes are **appended as a transcript delta**. "Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix" (`docs/extensions.md` "Activate tools dynamically", about line 144). The docs recommend editing structured prompt sections rather than returning a replacement `systemPrompt`, so that Pi can append a delta (`docs/extensions.md` "Events and concurrency").
- `context` is ephemeral and per call. Pi does nothing to stop a handler rewriting old messages. **Inference:** Pi, like OpenCode, relies on handlers being deterministic to keep the cache.
- Pi runs an active cache warmer with an economic decision that extensions can override (`cache-warmer.ts`).

### 3.4 Skills, prompts, presets

- Skills follow the Agent Skills spec: only name, description, and path go in the system prompt, and the model reads `SKILL.md` on demand (`docs/skills.md:1-65`). Prompt templates are Markdown `/` commands (`docs/prompt-templates.md`).
- **No built-in presets, modes, or subagents.** They are left to extensions. `examples/extensions/preset.ts:1-60` defines named presets in `presets.json` with `{provider, model, thinkingLevel, tools, instructions}`, selected by `--preset`, `/preset`, or a shortcut. Other examples: `plan-mode/`, `subagent/`, `permission-gate.ts`, `protected-paths.ts`, `custom-compaction.ts`, `trigger-compact.ts`, `handoff.ts`, `claude-rules.ts`, `tool-override.ts`, `provider-payload.ts`, `dynamic-tools.ts`, `ssh.ts`, `sandbox/`, `gondolin/` (listing of `packages/coding-agent/examples/extensions/`).

---

## 4. Oh My Pi (omp): differences from Pi

- **Same core extension model.** Factory, `pi.on`, `registerTool`, `registerCommand`, providers, renderers (`oh-my-pi:docs/extensions.md:17-66`). Tool schemas use its own `omptype`, with a TypeBox shim for older extensions (`docs/extensions.md:392`). Legacy `hooks/` and `custom-tools/` modules are adapted into the extension runner (`docs/hooks.md:1-14`; `docs/extensions.md:841-848`).
- **Extra events** (`docs/extensions.md:292-390`):
  - `session.compacting` alongside `session_before_compact`;
  - `session_stop`, a stop hook that can block or continue, capped at 8 advisory continuations;
  - `before_subagent_spawn`, which can reroute the model or block a spawn;
  - `tool_approval_requested/resolved`;
  - `ttsr_triggered`, `auto_compaction_*`, `auto_retry_*`, `mcp_notification`, `user_python`.

  `before_agent_start` has a documented retry and re-entry contract: handlers must tolerate re-entry, and only the accepted attempt's output is published. `tool_call` revisions are revalidated and persisted.
- **Built-in features Pi leaves to extensions:**
  - MCP (`docs/mcp-*.md`).
  - Subagents via a `task` tool with Markdown agent definitions in `.omp/agents/*.md` (`docs/task-agent-discovery.md:51, 140-167`).
  - Tool approval tiers `read/write/exec` with modes. Undeclared tools default to `exec`, and "MCP server tools declare `write`" (`docs/approval-mode.md:1-14`).
  - Model **roles** `default, smol, slow, vision, plan, commit, tiny, task, advisor`, referenced as `@role` (`docs/models.md:459-463`).
  - Rulebook and TTSR ("Time Traveling Stream Rules", which interrupt a streaming response when a rule matches and inject a correction) (`docs/rulebook-matching-pipeline.md:1-6`; `docs/ttsr-injection-lifecycle.md`).
  - LSP and native Rust crates for tools (`crates/pi-*`).
- **Cross-harness compatibility.** Discovery providers read config from `.claude`, `.codex`, `.cursor`, `.gemini`, `.opencode`, Cline, Windsurf, and VS Code (`packages/coding-agent/src/discovery/*.ts`). From `.claude` it loads MCP servers, skills, commands, system prompt, settings, and `hooks/pre|post/*.ts` modules (`discovery/claude.ts:1-100, 367-390`). **Inference:** I found no `PreToolUse` or `settings.json` hook handling, so Claude Code's shell-command hooks are probably not executed.
- **Marketplace.** Compatible with Claude Code's `.claude-plugin/marketplace.json` format, for example `/marketplace add anthropics/claude-plugins-official`. Plugins may contain skills, commands, agents, rules, hooks, tools, MCP, and LSP servers, plus `omp.extensions` modules (`docs/marketplace.md:1-18, 92-100`). A new install needs a session restart for tools, hooks, and extension modules (`marketplace.md:78`).
- **Trust.** "Extensions are **not sandboxed** (same process/runtime)" (`docs/extension-loading.md:269-273`).

---

## 5. Claude Code

The extension units are settings hooks, plugins, skills, slash commands, subagents, output styles, MCP servers, LSP servers, monitors, and the Agent SDK. Plugin code does **not** run in Claude Code's process: hooks are shell commands, HTTP endpoints, MCP tool calls, or LLM prompts and agents.

### 5.1 What the host offers

| Capability | Mechanism | When / cache effect |
|---|---|---|
| Add tools | MCP servers (plugin `.mcp.json`); a plugin's `bin/` is put on Bash's `PATH`; LSP servers ([plugins-reference, Standard layout](https://code.claude.com/docs/en/plugins-reference)) | session start. Connecting or disconnecting MCP re-reads the whole prefix unless the tools are deferred ([prompt-caching, Enabling or disabling a plugin](https://code.claude.com/docs/en/prompt-caching)) |
| System prompt | **Output styles** replace the built-in coding instructions unless `keep-coding-instructions: true` ([output-styles, How output styles work](https://code.claude.com/docs/en/output-styles)); `--append-system-prompt`; CLAUDE.md in the project-context layer | A mid-session style switch "delivers the new style's instructions as a message", which keeps the cache ([prompt-caching, Changing output style](https://code.claude.com/docs/en/prompt-caching)) |
| Add context | `additionalContext` from hooks, "wrap[ped] … in a system reminder and insert[ed] … at the point where the hook fired". Placement depends on the event: SessionStart and SubagentStart at the conversation start; UserPromptSubmit next to the prompt; tool hooks next to the tool result; Stop at the end of the turn. Values over 10,000 characters spill to a file ([hooks, Add context for Claude](https://code.claude.com/docs/en/hooks)). | **Append-only.** Saved in the transcript and replayed rather than re-run on `--resume`, so values go stale |
| Reshape history | **Not offered.** No hook edits or removes earlier messages. The docs describe the cache layers as system prompt, then project context, then conversation, with new content appended ([prompt-caching, How the cache is organized](https://code.claude.com/docs/en/prompt-caching)). | — |
| Intercept tool calls | `PreToolUse`: `permissionDecision` allow, deny, ask, or defer; `updatedInput` replaces the input; `additionalContext`. Precedence when several hooks disagree: deny > defer > ask > allow ([hooks, PreToolUse decision control](https://code.claude.com/docs/en/hooks)) | per tool call |
| Rewrite results | `PostToolUse`: `updatedToolOutput` (must match the tool's output shape), `decision: block` + `reason`, `additionalContext`, `classifierContext`. Also `PostToolUseFailure` and `PostToolBatch` ([hooks, PostToolUse decision control](https://code.claude.com/docs/en/hooks)) | per tool call |
| Compaction | `PreCompact` can only **block** (exit 2 or `decision: block`) and sees `custom_instructions`. `PostCompact` observes. No hook supplies a summary ([hooks, PreCompact](https://code.claude.com/docs/en/hooks)). | per compaction |
| Providers, models, auth | No plugin surface (env vars, gateways). `PreModelSwitch` and `PostModelSwitch` hooks exist ([hooks outline](https://code.claude.com/docs/en/hooks)). | — |
| Commands and UI | skills and commands (injected as user messages, cache-safe), themes, statusline, `MessageDisplay` hook, monitors (background processes whose output notifies the session) ([plugins-reference, `monitors`](https://code.claude.com/docs/en/plugins-reference)) | |
| Observe events | About 30 events, including SessionStart/End, Setup, InstructionsLoaded, UserPromptSubmit, Stop, SubagentStart/Stop, TaskCreated/Completed, ConfigChange, FileChanged, CwdChanged, WorktreeCreate/Remove, Notification, Elicitation ([hooks outline](https://code.claude.com/docs/en/hooks)). Hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`; `async` and `asyncRewake` background modes. "All matching hooks run in parallel" ([hooks, Hook handler fields](https://code.claude.com/docs/en/hooks)). | |
| Permissions | Allow, deny, and ask rules; permission modes; `PermissionRequest` and `PermissionDenied` hooks. A hook's `allow` cannot override deny or ask rules, and a hook's `ask` forces a prompt even in auto mode ([hooks, PreToolUse decision control](https://code.claude.com/docs/en/hooks)). Mode switches are cache-safe ([prompt-caching, Changing permission mode](https://code.claude.com/docs/en/prompt-caching)). | |

**Cache policy stated by the host:** "Claude Code never invalidates the cache for a plugin's skills, commands, agents, hooks, monitors, or themes. It appends their content after the existing conversation" ([prompt-caching, Plugin components that keep the cache](https://code.claude.com/docs/en/prompt-caching)). `/reload-plugins` refuses a reload that would force a full re-read unless `--force` is given. CLAUDE.md edits apply only after `/clear`, `/compact`, or a restart.

**Plugins and marketplaces.** A plugin is a directory with an optional `.claude-plugin/plugin.json` plus `skills/ commands/ agents/ hooks/hooks.json .mcp.json .lsp.json output-styles/ workflows/ themes/ monitors/ bin/ settings.json`. A plugin `settings.json` may set only `agent` and `subagentStatusLine`. A `CLAUDE.md` in the plugin root is not loaded ([plugins-reference, Standard layout; `settings`](https://code.claude.com/docs/en/plugins-reference)). Manifests declare `dependencies` on other plugins and `user_config` options. Marketplaces are git repos with `marketplace.json` ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)).

**Trust.** "Command hooks execute shell commands with your full user permissions." Interactive sessions hold back settings hooks until workspace trust is accepted, but "`-p` or SDK session … treats the folder as trusted, so hooks committed in a repository's `.claude/settings.json` run in a folder you've never trusted" ([hooks, Security considerations](https://code.claude.com/docs/en/hooks)). Plugin hooks are labelled `[plugin:<name>]` in permission prompts.

### 5.2 Subagents and presets

Subagent Markdown frontmatter is a named bundle: `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills` (preloaded), `mcpServers`, `hooks`, `memory`, `effort`, `isolation: worktree`, `omitClaudeMd`, `initialPrompt`, `experimental.cacheTtl`. The body becomes the subagent's **whole** system prompt. For **plugin** subagents, `permissionMode`, `mcpServers`, and `hooks` are ignored ([sub-agents, Frontmatter reference](https://code.claude.com/docs/en/sub-agents)). A subagent definition can run as the main session agent via `--agent` or the `agent` setting, which a plugin's `settings.json` may set. Output styles do not reach non-fork subagents ([sub-agents, What loads at startup](https://code.claude.com/docs/en/sub-agents)). Profiles were requested in [#7075](https://github.com/anthropics/claude-code/issues/7075) (+58, closed).

---

## 6. Codex CLI

- **Hooks** (feature `hooks`, stage Stable, on by default: `codex:codex-rs/features/src/lib.rs:1200-1205`). The events are PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt (`codex-rs/hooks/src/schema.rs:101-124`). PreToolUse can block, add `additional_contexts`, and return `updated_input` (`hooks/src/events/pre_tool_use.rs:41-52`). PostToolUse adds context (`post_tool_use.rs:43-50`). Compact hooks can only stop (`should_stop`, `stop_reason`) (`hooks/src/events/compact.rs:46-55`). Admins can enforce managed-hooks-only (`docs/config.md:9-15`). The old `notify` program is still in config (`codex-rs/config/src/config_toml.rs:230`). Event hooks were requested in [#2109](https://github.com/openai/codex/issues/2109) (+689, closed).
- **Plugins.** The manifest's `paths` hold `skills`, `mcp_servers`, `apps`, and `hooks`, plus a presentation `interface` (`codex-rs/plugin/src/manifest.rs:8-57`). Marketplaces are in `codex-rs/core-plugins/src/marketplace*.rs`. Top-level `plugins` config lives at `config_toml.rs:477`. Plugin-provided hooks (`plugin_hooks`) are marked **Removed** as a separate feature (`features/src/lib.rs:1425-1430`); **inference:** they now go through the manifest `hooks` path. Agents in plugins are still requested ([#18308](https://github.com/openai/codex/issues/18308) +69, [#18988](https://github.com/openai/codex/issues/18988)), as are repo-scoped marketplaces ([#18115](https://github.com/openai/codex/issues/18115)).
- **Prompt.** `developer_instructions`, `model_instructions_file` (replaces the base instructions), and `compact_prompt` (replaces the compaction prompt) (`config_toml.rs:237, 255, 258`). AGENTS.md is read (`docs/agents_md.md`). No history transform surface was found.
- **Providers.** `[model_providers]` (`config_toml.rs:312`).
- **Presets.** `[profiles.<name>]` config overlays chosen per run (`config_toml.rs:342-346`). **Agent roles** carry `description`, `config_file`, and `nickname_candidates`, and each role is a TOML config overlay (`codex-rs/agent-roles/src/agent_role_config.rs:13-35`; `agents` at `config_toml.rs:461`).
- **Trust.** Sandbox modes and exec policy apply to model-issued commands (`docs/sandbox.md`, `docs/execpolicy.md`). Hooks are external commands.

---

## 7. What plugin authors actually build (37 surveyed)

"Surfaces" names the host hooks each plugin relies on. Local-clone citations are to files under `~/Work/OSS/<repo>`. Where only a catalogue description was available, the surface is labelled **inference**.

### Context management and compression
| Plugin | Host(s) | Surfaces |
|---|---|---|
| [opencode-dynamic-context-pruning](https://github.com/Tarquinen/opencode-dynamic-context-pruning) (prunes obsolete tool outputs) | OC1 | `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.text.complete`, `command.execute.before` (`index.ts:57-72`) |
| [context-mode](https://github.com/mksglu/context-mode) | CC, OC1, Pi (pi.dev listing) | CC hooks PreToolUse, PostToolUse, PreCompact, SessionStart, UserPromptSubmit; OC `tool.execute.before/after`, `experimental.session.compacting`; MCP tools (`server.bundle.mjs`) |
| [condensed-milk-pi](https://github.com/tomooshi/condensed-milk-pi) | Pi | `before_agent_start`, `tool_result`, `context`, `registerCommand` (`index.ts:263, 416, 510, 621`) |
| [billion-context](https://github.com/ranxianglei/billion-context) | Pi, OC, Codex, CC | context compression across hosts (pi.dev); surfaces not inspected |
| [opencode-morph-plugin](https://github.com/morphllm/opencode-morph-plugin) | OC1 | fast apply, search, and compaction via Morph (ecosystem.mdx); **inference:** tools + compaction hook |
| [lean-ctx](https://github.com/yvgude/lean-ctx) | Pi | MCP bridge `registerTool`, commands (`packages/pi-lean-ctx/extensions/mcp-bridge.ts:235`, `index.ts:797`) |
| [rtk](https://github.com/rtk-ai/rtk) (rewrites shell commands to compact output) | Pi, OC1, CC-style | Pi `tool_call` (`hooks/pi/rtk.ts:59`), OC `tool.execute.before` (`hooks/opencode/rtk.ts:19`), PreToolUse (`.github/hooks/rtk-rewrite.json:3`) |
| [headroom](https://github.com/chopratejas/headroom) | CC, OpenClaw | CC plugin hooks SessionStart and PreToolUse (`plugins/headroom-agent-hooks/hooks/hooks.json:4,16`) |
| [opencode-type-inject](https://github.com/nick-vi/opencode-type-inject) | OC1 | injects types into file reads; **inference:** `tool.execute.after` + tools |

### Memory
| Plugin | Host(s) | Surfaces |
|---|---|---|
| [hindsight](https://github.com/vectorize-io/hindsight) integrations | OC1, CC, Pi | OC `experimental.chat.system.transform` + `experimental.session.compacting` (`hindsight-integrations/opencode/src/hooks.ts:5,9`); CC SessionStart + UserPromptSubmit (`omo/hooks/hooks.json:3,14`); Pi `before_agent_start` (`coding-agents/src/harness/pi-extension.ts:179`) |
| [memorix](https://github.com/AVIDS2/memorix) | OC1, MCP | `experimental.session.compacting` (`.opencode/plugins/memorix.js:76`), MCP tools (`src/server.ts:14`) |
| [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory) | OC1 | cross-session memory (ecosystem.mdx) |
| [pi-memory](https://github.com/jayzeng/pi-memory), pi-hermes-memory | Pi | memory with semantic search (pi.dev) |

### Tool packs
| Plugin | Host | Notes |
|---|---|---|
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Pi | adds MCP to Pi, which has none built in (pi.dev) |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Pi | search, fetch, PDF, video tools |
| [opencode-firecrawl](https://github.com/firecrawl/opencode-firecrawl), [opencode-tavily](https://github.com/tavily-ai/opencode-tavily), [opencode-websearch-cited](https://github.com/ghoulr/opencode-websearch-cited) | OC1 | web tools |
| [opencode-pty](https://github.com/shekohex/opencode-pty) | OC1 | background PTY tools |
| [pi-lens](https://github.com/apmantza/pi-lens) | Pi | LSP, lint, and typecheck feedback |
| [opencode-morph-fast-apply](https://github.com/JRedeker/opencode-morph-fast-apply) | OC1 | edit tool replacement |

### Guardrails and policy
| Plugin | Host | Surfaces |
|---|---|---|
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | CC, Pi | blocks destructive commands and secret-file access (PreToolUse-style) |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | Pi | permission enforcement via `tool_call` (**inference**, since Pi has no permission API) |
| [opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard) | OC1 | redacts secrets and PII before LLM calls and restores them locally; **inference:** `messages.transform` + `tool.execute.after` |
| Pi examples `permission-gate`, `protected-paths`, `sandbox/`, `gondolin/` | Pi | `tool_call` block; routing tools into a sandbox or micro-VM (`examples/extensions/README.md:15-30`) |
| [opencode-shell-strategy](https://github.com/JRedeker/opencode-shell-strategy) | OC1 | prompt guidance only |

### Observability and cost
[opencode-helicone-session](https://github.com/H2Shami/opencode-helicone-session) (OC `chat.headers`, per its description); [opencode-wakatime](https://github.com/angristan/opencode-wakatime), [opencode-sentry-monitor](https://github.com/stolinski/opencode-sentry-monitor) (OC `event`, **inference**); [@langfuse/pi-observability-plugin](https://github.com/langfuse/pi-observability-plugin), [@langchain/langsmith-pi-extension](https://pi.dev/packages), [@braintrust/pi-extension](https://pi.dev/packages) (Pi lifecycle events); rpiv-telemetry (Pi `registerProvider`, `rpiv-mono/packages/rpiv-telemetry/dispatcher.ts:32`).

### Auth and providers
[opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth), [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth), [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) (OC `auth` hook); [opencode-claude-auth](https://github.com/ualtinok/opencode-claude-auth) (OC `auth` + `experimental.chat.system.transform`); [pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth) (Pi `registerProvider`, `src/index.ts:64`); [pi-provider-litellm](https://github.com/balcsida/pi-provider-litellm); [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) (Claude Code via the Agent SDK as a Pi provider, plus an AskClaude tool).

### UI and notifications
[opencode-notifier](https://github.com/mohak34/opencode-notifier), [opencode-notificator](https://github.com/panta82/opencode-notificator) (OC `event`); [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) (Pi `ctx.ui.setFooter`); [@plannotator/opencode](https://github.com/backnotprop/plannotator) (plan review UI); [octto](https://github.com/vtemian/octto) (browser forms).

### Workflow, orchestration, and bundles
| Plugin | Host | Surfaces |
|---|---|---|
| [oh-my-opencode / oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OC1 | `tool.execute.before/after`, `chat.params`, `chat.headers`, `permission.ask`, Claude-Code hook emulation (`src/plugin/tool-execute-before.ts:65`, `chat-params.ts:83`, `src/hooks/claude-code-hooks/pre-compact.ts:34`) |
| [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) | OC1 | `/preset` via `command.execute.before` that rewrites agent models through `client.config.update()` (`src/tools/preset-manager.ts:1-30`); `chat.headers` (`src/hooks/chat-headers.ts:68`) |
| [superpowers](https://github.com/obra/superpowers) (skills library) | CC, OC1 | CC SessionStart hook (`hooks/hooks.json:3`); OC `experimental.chat.messages.transform` (`.opencode/plugins/superpowers.js:101`) |
| [opencode-handoff](https://github.com/joshuadavidthomas/opencode-handoff) | OC1 | `chat.message` (`src/plugin.ts:61`) |
| [opencode-swarm](https://github.com/zaxbysauce/opencode-swarm) | OC1 | `tool.execute.before/after`, `chat.message` (`src/state.ts:5-6`) |
| [OpenCode-goal-plugin](https://github.com/willytop8/OpenCode-goal-plugin) (`/goal` that auto-continues) | OC1 | `command.execute.before`, `experimental.chat.system.transform` (`src/goal-plugin.js:899, 1288`) |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Pi | `registerTool`, `tool_result`, `context`, `before_agent_start`, `registerCommand` (`src/extension/index.ts:475, 511`; `src/runs/shared/subagent-prompt-runtime.ts:128-134`) |
| [rpiv-mono](https://github.com/juicesharp/rpiv-mono) (advisor, todo, ask-user) | Pi | `before_agent_start`, `registerTool`, `registerCommand`, `tool_call` (`packages/rpiv-advisor/advisor/*.ts`; `rpiv-pi/extensions/rpiv-core/session-hooks.ts:92`) |
| [opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents), [@openspoon/subtask2](https://github.com/spoons-and-mirrors/subtask2), [micode](https://github.com/vtemian/micode), [opencode-conductor](https://github.com/derekbar90/opencode-conductor), [opencode-workspace](https://github.com/kdcokenny/opencode-workspace), [opencode-worktree](https://github.com/kdcokenny/opencode-worktree), [opencode-devcontainers](https://github.com/athal7/opencode-devcontainers), [opencode-daytona](https://github.com/daytona/integrations/tree/main/packages/opencode-plugin), [opencode-scheduler](https://github.com/different-ai/opencode-scheduler) | OC1 | orchestration, isolation, scheduling (ecosystem.mdx descriptions) |
| [@akagilnc/pi-workflow-roles](https://github.com/Akagilnc/ak-pi-workflow-roles), @narumitw/pi-plan-mode, pi-goal variants | Pi | roles and modes as extensions (pi.dev) |
| [ocx](https://github.com/kdcokenny/ocx) | OC | "extension manager with portable, isolated profiles" (ecosystem.mdx) |

**Observed patterns (inference from the table):**
1. Context and memory plugins cluster on the per-request transforms (`messages.transform`, `system.transform`, Pi `context` and `before_agent_start`) and on compaction hooks. These are exactly the surfaces with no cache protection.
2. Many authors ship the same product to three or four hosts (context-mode, rtk, hindsight, billion-context, superpowers, cc-safety-net). A host-neutral core with thin adapters is normal practice.
3. Workflow plugins emulate missing host features: presets (oh-my-opencode-slim, the Pi preset example), subagents (pi-subagents), stop and continue loops (goal plugins), MCP (pi-mcp-adapter), permissions (pi-permission-system).

---

## 8. Pain points and gaps

**Missing or broken hooks**
- OpenCode `permission.ask` was declared but never called for the whole 1.x line ([#7006](https://github.com/anomalyco/opencode/issues/7006) +26, open; three unmerged PRs listed in §1.2).
- `tool.execute.before` did not intercept subagent tool calls: "security policy bypass" ([#5894](https://github.com/anomalyco/opencode/issues/5894)).
- Requests: a stop or continue hook ([#16626](https://github.com/anomalyco/opencode/issues/16626), PR [#44712](https://github.com/anomalyco/opencode/pull/44712)); session start and shutdown ([#15224](https://github.com/anomalyco/opencode/pull/15224), [#10524](https://github.com/anomalyco/opencode/issues/10524), [#28695](https://github.com/anomalyco/opencode/issues/28695)); injecting AI-visible messages ([#17412](https://github.com/anomalyco/opencode/issues/17412)); model routing before a call ([#18793](https://github.com/anomalyco/opencode/issues/18793), [#20235](https://github.com/anomalyco/opencode/issues/20235) +38); MCP call headers ([#28225](https://github.com/anomalyco/opencode/issues/28225)); a V2 model-context hook ([#35408](https://github.com/anomalyco/opencode/issues/35408)); command cancellation ([#18559](https://github.com/anomalyco/opencode/pull/18559)).
- UI requests: statusline ([#8619](https://github.com/anomalyco/opencode/issues/8619) +51), sidebar panels ([#5971](https://github.com/anomalyco/opencode/issues/5971) +55), a cross-client UI intent channel ([#6330](https://github.com/anomalyco/opencode/issues/6330)), footer items ([#18969](https://github.com/anomalyco/opencode/issues/18969)).
- Claude Code: compaction content control ([#14258](https://github.com/anthropics/claude-code/issues/14258) +48; PostCompact was added, but hooks still cannot supply a summary per the docs); plan-mode hooks ([#14259](https://github.com/anthropics/claude-code/issues/14259) +60); a user-interrupt hook ([#9516](https://github.com/anthropics/claude-code/issues/9516) +67); rules in plugins ([#14200](https://github.com/anthropics/claude-code/issues/14200) +119); disabling individual plugin skills ([#14920](https://github.com/anthropics/claude-code/issues/14920) +94).
- Pi: exposing the model runtime to extensions ([#8791](https://github.com/earendil-works/pi/issues/8791)); `--tools` should filter extension tools too ([#2835](https://github.com/earendil-works/pi/issues/2835)); package management and hot reload ([#645](https://github.com/earendil-works/pi/issues/645)).
- Codex: event hooks ([#2109](https://github.com/openai/codex/issues/2109) +689); Claude-style plugins ([#8512](https://github.com/openai/codex/issues/8512) +88); agents in plugins ([#18308](https://github.com/openai/codex/issues/18308)).

**Prompt cache**
- OpenCode: a plugin appending through the supported hook silently kills cache reads, and the report says the cost is "invisible and unavoidable" ([#43507](https://github.com/anomalyco/opencode/issues/43507)). Also see §1.3 and §2.3.
- Pi: prompt and tool changes cost a full checkpoint on providers that cannot express a delta (§3.3).
- Claude Code handles this by design: it appends only, and refuses reloads that would force a re-read (§5.1).

**Ordering and conflicts**
- OpenCode 1.x uses a single load order, and all plugins mutate one shared output object (`plugin/index.ts:284-297`). PR [#19961](https://github.com/anomalyco/opencode/pull/19961) proposes firing `system.transform` before `messages.transform`, which shows that the order between hooks matters to authors.
- One plugin's rejection aborted unrelated parallel sessions ([#28958](https://github.com/anomalyco/opencode/issues/28958)).
- Registering agents and commands depends on undocumented config mutation ([#24065](https://github.com/anomalyco/opencode/issues/24065)). Model-conditional tool substitution breaks model-agnostic plugins ([#19942](https://github.com/anomalyco/opencode/issues/19942)).
- In V2, a failed deferred plugin transform "bricks catalog" ([#44920](https://github.com/anomalyco/opencode/issues/44920)), and the `provider.models()` hook regressed ([#25630](https://github.com/anomalyco/opencode/issues/25630)).
- Claude Code runs matching hooks in parallel and resolves conflicting PreToolUse decisions by fixed precedence (§5.1).
- Pi runs in load order; in `tool_call`, later handlers see earlier mutations and there is no re-validation after mutation (`types.ts:1024-1028`). omp added revalidation.

**Distribution and versioning**
- OpenCode: stale `@latest` caches ([#25293](https://github.com/anomalyco/opencode/issues/25293), [#16608](https://github.com/anomalyco/opencode/issues/16608)); a package cached under two keys ([#48514](https://github.com/anomalyco/opencode/issues/48514)); marketplace requested ([#28696](https://github.com/anomalyco/opencode/issues/28696) +41).
- The whole V1 ecosystem breaks at V2 (`migrate-v1.mdx:541`).
- Pi: global installs could not resolve Pi's own packages ([#1831](https://github.com/earendil-works/pi/issues/1831)); TUI singletons break across realms ([#4748](https://github.com/earendil-works/pi/issues/4748)); jiti path resolution (PR [#8112](https://github.com/earendil-works/pi/pull/8112)).

**Trust and sandboxing**
- No host sandboxes plugin code.
  - OpenCode and Pi run it in-process with full access (§1.1, §3.1).
  - omp says so explicitly (§4).
  - Claude Code and Codex run hooks as user-privileged subprocesses. Claude Code headless runs trust the repo's `.claude/settings.json` hooks automatically (§5.1).
- Pi and Claude Code gate project-level resources behind a trust prompt.
- omp's approval tiers default unknown tools to `exec`.
- Claude Code labels hook provenance in prompts.

---

## 9. Presets, profiles, and agent-to-plugin mapping

| Host | Named bundle concept | Can a plugin declare one? | Per-session selection |
|---|---|---|---|
| OpenCode 1.x | Agents (prompt, model, permission-as-tools, temperature); commands pin agent and model | Only by mutating config in the `config` hook (unofficial, #24065). Hooks receive `agent` only for params and headers. | Tab-cycle primary agents; `@subagent`; commands. Community presets swap agent models (oh-my-opencode-slim `/preset`); ocx profiles. |
| OpenCode 2.x | Agents via `agent.transform`; plugin `options` | Yes: first-class `agent.transform` / `command.transform` / `skill.transform` / `tool.transform`. All hooks receive `agent`, so per-agent behaviour means branching inside a hook. | `session.switchAgent/switchModel`. I found no "profile" object bundling plugins, tools, and prompt (**inference**). |
| Pi | None built in (by design) | Extensions implement presets (`examples/extensions/preset.ts`: provider, model, thinking, tools, instructions) using `setActiveTools`, `setModel`, and `before_agent_start` | `--preset`, `/preset`, shortcut (example). Pi packages bundle resources but are not selectable per session. |
| omp | Model roles (`@smol`, `@plan`, ...); task agents in `.omp/agents/*.md` with frontmatter (model role, prewalk, advisor); approval modes | Plugins and extension packages can ship agents (`task-agent-discovery.md:140-167`) | task tool per spawn; `before_subagent_spawn` can reroute |
| Claude Code | Subagent definitions (tools, model, permissionMode, skills, MCP, hooks, memory, effort, isolation, cacheTtl); output styles | Plugins ship agents, but plugin agents ignore `hooks`, `mcpServers`, `permissionMode`. Plugin `settings.json` can set the default main `agent`. | `--agent` or the `agent` setting for the main thread; automatic or explicit delegation per task; `/output-style` |
| Codex | `[profiles.<name>]` config overlays; agent roles = config-file overlays | Plugins cannot ship agents yet (#18308, #18988) | `--profile`; role per spawned agent |

**Inference:** the common shape is a named bundle = {model/effort, tool allow-list, prompt fragment, permission posture, optional hooks/MCP}. Every host binds it either to an **agent** (Claude Code, OpenCode, omp, Codex roles) or to a **session-level switch** (Pi preset example, Codex profiles, Claude Code output styles). No host lets a *plugin* declare a bundle that turns *other plugins'* behaviour on or off per session. Plugins receive the agent ID and must branch themselves.

---

## 10. Synthesis

### 10.1 Extension needs common to all hosts
1. Register tools, and toggle their visibility per agent or session.
2. Add guidance to the prompt (static rules, memory recall, status notices).
3. Transform context before each model call (pruning, compression, redaction, reminders).
4. Intercept tool calls: block, rewrite arguments, rewrite or annotate results.
5. Compaction: add context, replace the prompt, supply one's own summary, or block.
6. Providers, models, and auth (OAuth subscriptions, proxies, routing).
7. Commands, UI (status, footer, dialogs, notifications), renderers.
8. Lifecycle observation (session start and end, turn end, stop, subagent spawn, errors) for telemetry and continuation loops.
9. Permission policy that composes with the user's rules.
10. Named bundles (agents, presets, profiles) and a way for plugins to ship them.

### 10.2 Per-session static versus per-request
- **Can be pinned once at session start (inference):** the tool set and its schemas; the system-prompt header and static guidance (Claude Code loads CLAUDE.md once per session and after compaction); provider, model, and auth registration; the agent or preset bundle; commands and UI; permission rules. Claude Code and Pi already treat changes to these as expensive: Claude Code refuses cache-busting reloads, and Pi appends a delta.
- **Genuinely per request:** memory recall tied to the current prompt; status and budget notices; pruning and compression of recent tool output; redaction; retry and routing decisions; tool-call interception; headers and tracing.
- **Per event:** compaction and subagent spawn.

### 10.3 Touching history versus appending only
- **Append-only is enough for:** guidance and reminders, memory recall, notices, tool-result annotations, stop and continue feedback, preset or style switches. This is Claude Code's whole model (`additionalContext`, style-as-message) and Pi's `sendMessage` and `turn_end` entries.
- **Requires touching history:** context pruning and compression (DCP, condensed-milk, context-mode), redaction and restoration (vibeguard), rewriting old tool results, custom compaction that chooses what to keep (Pi `session_before_compact`), `message_end` replacement.
- **Inference:** only OpenCode (`messages.transform`, V2 `context`) and Pi (`context`, `context_with_system`) expose history rewriting, and neither detects or bounds prefix mutation. #43507 shows that even append-only use of a rewrite hook can defeat cache placement when the host picks breakpoints by position. Separating "append a message" from "rewrite history", and letting the host place cache breakpoints with knowledge of what plugins added, would remove the most expensive failure authors hit today.

### 10.4 Trust and safety concerns for third-party code
- **In-process execution with full privileges** (OpenCode 1.x and 2.x, Pi, omp). A plugin can read credentials, rewrite any prompt or tool result, and spawn processes. None of these hosts sandboxes plugin code or scopes its capabilities.
- **Subprocess hooks** (Claude Code, Codex) isolate memory but still run with user permissions. Claude Code headless runs trust repo hooks automatically.
- **Silent influence.** Hooks that rewrite tool output or history can change what the model believes. Claude Code warns that stripping error details "can cause it to proceed on a false assumption". Injected text framed as instructions can trip prompt-injection defences.
- **Policy bypass paths:** subagent tool calls not covered by hooks (OpenCode #5894); a hook `allow` versus configured rules (Claude Code evaluates deny and ask rules regardless; V2's configured `deny` is final).
- **Failure isolation:** one plugin failing aborted parallel sessions (#28958) or bricked a registry (#44920).
- **Supply chain:** npm `@latest` auto-install at startup (OpenCode), `pi install` of git and npm packages, marketplaces (Claude Code, omp, Codex). The protections are project-trust gates (Pi, Claude Code), provenance labels (Claude Code), and managed-hooks-only enforcement (Codex).
- **Inference:** a CK plugin surface that declares capabilities (tools, prompt append, history rewrite, network, filesystem) up front, and grants history rewrite separately from append, would let the host enforce cache safety and give users a meaningful trust decision.
