# Magic Context's `tool.catalog` answer, v1

Status: **plan, revised with the extensibility room's rulings (r2).** Every
question the room was asked is decided (§7). The Rust module serves
`tool.catalog` and `role.describe` from the shared definition (§6), and does not
yet declare `tool-provider/v1` (§8). The example payloads in
[`mc-tool-catalog-v1/`](mc-tool-catalog-v1/) are the exact bytes Magic Context
serves; the module's tests compare its answers with them byte for byte. They
are regenerated, and checked against the plugin's shipped strings, the Rust
module's guidance assets and the commons and prefrontal test vectors, by
`bun docs/designs/mc-tool-catalog-v1/generate.ts --check`.

**Role-catalog update:** §2.1 below is the current ck-mc contract. Historical
plugin variant names elsewhere in this design describe the unchanged OpenCode
and Pi surfaces, not catalog presets. Use `--examples-only --check` to check
the local examples independently of external vectors; `--check` also enforces
the Prefrontal plan compatibility fence at the pinned ref. The visibility-based
subagent warning is deferred pending an agreed `present_tools` request field;
neither the commons request nor the current Claude Code guidance fetch carries
that set. No serializer or guidance epoch changes accompany this update.
The [role update report](mc-tool-catalog-v1/role-presets-report.md) records the
before/after digests and the vector results against Prefrontal `22d9b3dafa95`.

## Summary

- **One fetch, five tools, one text.** Magic Context answers `tool.catalog` with
  `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory` and `ctx_search` (in that
  order), and with its guidance as `system_text` when the plan asks for it. It
  declares no session-level capabilities: every Magic Context call settles inside
  its own reply.
- **Three role presets, chosen by core.** `head`, `worker` and `reader` select
  the role. Only `composition.compaction.provider == "magic-context"` selects
  Magic Context compaction. Missing compaction means not compacting.
- **Two knobs and a frozen model.** Light or full wording comes from the shared
  `tool_descs` param on the tool item and an MC `surface` param on the text
  item. When neither is given, it comes from the user's existing
  `prompt_surface` config, looked up with an optional `model` param that is
  frozen with the plan. A model switch applies at the next refresh. Everything
  else comes from user and project config.
- **The text reads only Magic Context's own composition entry.** Whether
  `ctx_reduce` is present picks the stamping (tagged) or the no-reduce text;
  whether `ctx_memory` is present picks the pinboard paragraph. Today those come
  from agent permissions, session metadata and the request's serializer profile;
  under this plan they come from the composition the starter computed.
- **What leaves the system text.** No runner adds or expects a date in system
  text. The per-session "Today's date" line the Rust module appends today moves
  to the head of m0 on runner-driven sessions; OpenCode and Pi keep the host's
  line. Session ids, agent names, and live state such as memories, history and
  project docs never enter a fetched byte. Memories, history and docs already
  live in m0 and m1.
- **Claude Code maps forward.** The gateway expects exactly
  `mcp__subc__magic-context_<catalog name>` for each catalog tool and never
  parses wire names back. `ctx_reduce` counts only if its name and schema both
  match, so its name and schema are frozen for v1.
- **Deploys stop costing a rebuild per session.** Today a guidance change busts
  every live session's prefix once on its next turn (OpenCode and Pi) or after
  a Thalamus restart (Claude Code). Under the frozen manifest, a deploy changes
  only new sessions. A head picks the change up at its next dead prefix, under the
  owner's default `on_prefix_rebuild` policy, at no extra cost.
- **Parity.** The example texts for `primary`, its light surface and the
  no-reduce variant are byte-identical to the Rust module's four shipped
  guidance assets that Claude Code gets today, minus the date line. The
  `tools-only` texts are new (§7.2).
  Tool descriptions match the plugin's, and one Rust description is missing a
  line. The argument schemas are reconciled: today the plugin and the Rust module
  advertise different structures, and this plan fixes one.
- **Fifteen decisions.** §7 records each ruling and who made it. The last,
  found while applying the rulings, gives `tools-only` its own text, because
  the no-reduce text describes Magic Context's own compaction (§7.2).

## 1. Sources

| Tag | Source |
|---|---|
| D | `.cortexkit/alfonso/plans/ck-extensibility-design-r7.3.md` (gitignored, present in worktrees) |
| E | `.cortexkit/alfonso/plans/ck-extensibility-r7.3-errata.md`. Overrides D where they differ. |
| TP | commons `crates/cortexkit-role-tool-provider/CONTRACT.md`, `src/catalog.rs` and `src/lib.rs`, `origin/master` at `42949fc3` (cortexkit-role-tool-provider 0.4.3, which defines the ten unprefixed tags and `check_capability_tag`). `catalog.rs` is unchanged since `5262544e`, which r1 cited. |
| TPV | commons `test-vectors/tool-provider-v1/` at the same commit |
| FP | prefrontal `test-vectors/fetch-plan-v1/` at `7079a4025` (README and vectors) |

Magic Context sources are cited by repository path and line.

The rules this plan has to meet:

- **The fetch.** A provider's preflight tool section is `tool.catalog` called with
  the session's context. The runner fetches the same op once per provider, with the
  composition, and the text item rides the same fetch as `system_text` (D §4.2 line
  167, D §4.5 lines 225–227, D §9.1 lines 941–943; E line 24: `system_prompt.text`
  is retired).
- **Purity.** The bytes are a pure function of preset, params, the composition,
  user-tier config, project-tier config and host facts. Scope, owner and agent are
  attribution only (D §4.2 line 169, D §9.1 line 944). E lines 154–158 narrow
  what may choose a variant: only provider ids, tool names and capability tags
  from the composition, plus preset, params, user config and project config.
  Scope, agent and session identity never enter a fetched byte. The only
  exception is Prefrontal's head persona (E lines 165–169).
- **Project text.** A project setting may only select among texts the provider
  ships, never add text (D §4.2 line 169, D §4.3 line 186). Per-session content,
  such as docs, memories and counts, is user-role content (D §4.3).
- **Composition.** Only text varies with peers. Names and schemas never do. A
  provider sees only peers' module ids, tool names and tags. It picks the
  richest variant the composition satisfies and never requires a peer (D §4.5
  lines 209–216, D §4.2 line 170).
- **Answer shape.** `{generation, catalog_digest, composition_digest?, tools,
  system_text?, capabilities?}`. Each tool is `{name, schema_digest, semantics,
  result_ops?, capabilities, description?, input_schema}`. `system_text` is
  `{text, item_digest, preflight_digest, composition_digest}`. A `digest_only`
  answer is `{generation, catalog_digest}` with the same `catalog_digest` (TP §3;
  `catalog.rs` lines 119–140, 203–225, 278–284).

## 2. The payload

### 2.1 What Magic Context accepts

The request is TP's `CatalogRequest`: `{params, preset?, composition?,
system_text?, digest_only?}`. Magic Context defines the following.

**Presets** (the tool item's `preset` and `system_text.preset`; both must name
the same preset):

| Preset | Magic Context compacts | Tools (before config/params filtering) | Text |
|---|---|---|---|
| `head` | no | `ctx_note`, `ctx_memory`, `ctx_search` | Existing tools-only text |
| `worker` | no | none | empty |
| `reader` | no | none | empty |
| `head` | yes | `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search` | Existing primary text |
| `worker` | yes | `ctx_reduce`, `ctx_expand`, `ctx_search` | Existing subagent text; no memory/note tool mentions |
| `reader` | yes | `ctx_reduce`, `ctx_expand`, `ctx_search` | Same as worker |

- **Aliases and default.** The definition's one `preset_aliases` table maps
  `primary` → `head`, `subagent` → `worker`, `tools-only` → `head`. Aliases
  never imply compaction. An absent preset means `head`.
- **Who compacts.** The request's frozen composition may carry
  `compaction: {"provider": "<module id>"}`. It must be omitted when the plan
  has no compaction item, never null. Only Magic Context's module id selects
  its compaction tools and text; another id is equivalent to missing for tool
  selection. The composition digest covers the member when present.
- **Plan compatibility.** An empty helper catalog is a valid answer, but a
  worker/reader plan without Magic Context compaction must omit Magic Context
  items entirely. The generator's cross-check rejects those items and unknown
  Magic Context presets in actual plan item arrays, not inferred filenames.
- **Per-call admission.** Fleet envelopes carry a top-level `preset` only,
  not caller-asserted compaction state. A full successful catalog fetch with a
  composition freezes the tools and compaction decision for the bound session;
  preflight and digest-only probes do not replace it. `ctx_reduce` is refused
  when that state does not grant compaction. `ctx_memory` and `ctx_note` are
  refused for worker/reader calls even when a shared head list exposes them.
  Refusals use the role's `unknown_tool` code, message `no tool named <name>`,
  detail `{"tool": "<name>"}`. Unknown presets use `invalid_request`, message
  `Magic Context defines no preset "<name>"`, detail `{"field": "preset"}`.
  Legacy plugin and Claude Code MCP calls without a fleet preset or frozen
  catalog keep their own path, even on a route declaring `tool-provider/v1`.

`role.describe` remains build-only discovery: ops, stability, version and
capabilities, never a tool list. All catalog strings and role aliases live in
the shared JSON definition consumed by the Rust module and TypeScript generator.
The OpenCode and Pi primary/subagent guidance and plugin tool definitions are
unchanged.

**Tool-item params** (`params`):

| Param | Values | Effect |
|---|---|---|
| `scope` (shared) | `read`, `readwrite`, `all` | `read` serves `ctx_reduce`, `ctx_expand` and `ctx_search`: they change nothing outside the session's own view. `readwrite` and `all` serve all five. Absent means `all`. |
| `tool_descs` (shared) | `concise`, `full` | `concise` serves the light descriptions, `full` the full ones. Absent: see "Surface resolution" below. |
| `exclude` (shared) | tool names | Those tools are absent from the answer. A name Magic Context doesn't serve is refused `invalid_request {field: "params.exclude"}`. |
| `behavior` (shared) | `autonomous`, `interactive` | Accepted, and changes no byte. |
| `model` (MC) | a canonical `provider/model` key | Optional. Frozen with the plan. Used only to look up `prompt_surface.models` in Magic Context's own config when `tool_descs` (or, on the text item, `surface`) is absent (decision 4). |

**Text-item params** (`system_text.params`): `surface` (`light` or `full`),
and `model` as above. Any other key or value is refused, never guessed (D §4.1).

**Surface resolution.** An explicit `tool_descs` or `surface` decides. Otherwise
`prompt_surface.models` is looked up with the `model` param, then
`prompt_surface.default` applies, through the existing lookup order: exact key,
bare model id, shorter model ids, then the provider wildcard
(`packages/plugin/src/shared/prompt-surface.ts:69-153`). So Magic Context's own
config resolution stays the only one that reads its settings, as D §4.2 line
162 requires; the starter never interprets them. Because the `model` param is
frozen with the plan, a model switch changes nothing until the owner's next
refresh, which carries the new model (§5.2). The `tools-only-light` example
reaches light wording this way: its `model` is `anthropic/claude-haiku-4-5`,
which the example config maps to `light`.

### 2.2 The tools

Order is the plugin's single tool list, `ACTIVE_TOOL_IDS`
(`packages/plugin/src/shared/prompt-surface-runtime.ts:32-38`).

| Tool | Capability tag | `result_ops` | `semantics` | `schema_digest` |
|---|---|---|---|---|
| `ctx_reduce` | `magic-context:context.reduce/v1` | `prepend`, `append` | 1 | `69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6` |
| `ctx_expand` | `magic-context:history.expand/v1` | `prepend`, `append` | 1 | `cd7582da38e25a39a29aa42441d41c4e962289d47b16701ead53514c87900f1c` |
| `ctx_note` | `magic-context:notes/v1` | `prepend`, `append` | 1 | `f44043a45d8871421db70b4b94e838b684b9360ebc92017f201579a06ad0afd0` |
| `ctx_memory` | `magic-context:memory.write/v1` | `prepend`, `append` | 1 | `7a6a1d3f8c5e61d6104805e30e549c9d0e5172d023415a98cb225e0a6af89879` |
| `ctx_search` | `magic-context:archive.search/v1` | `prepend`, `append` | 1 | `f0d56f456f2ee9569c030072d33a001ae45d8a57d792dbf4d51c59eb12da28e9` |

- **Tags are namespaced.** Tool-provider §3 (cortexkit-role-tool-provider
  0.4.3) defines ten unprefixed tags: `shell.exec/v1`, `code.read/v1`,
  `code.edit/v1`, `code.search/v1`, `code.files/v1`, `code.outline/v1`,
  `code.callgraph/v1`, `code.diagnostics/v1`, `browser.use/v1` and
  `computer.use/v1`. Every other tag is `<namespace>:<name>/v<N>`. None of the
  ten describes a Magic Context tool, so Magic Context ships only
  `magic-context:*` tags (decision 9). A peer that relies on stamping matches
  `magic-context:context.reduce/v1`.
- **Every tag in the payloads passes the role's check.** The generator checks
  every tag in every example request and answer with a port of
  `check_capability_tag`, and compares its list of defined tags with the
  crate's `DEFINED_CAPABILITY_TAGS` at `42949fc3`. The module's tests run the
  crate's own function (0.4.3) over every tag in the payloads. The examples tag
  Prefrontal's forwarding tools in the role's two tiers: the generic
  `browser.use/v1` or `computer.use/v1`, which promises only that a browser or
  desktop is driven, beside `cerebellum:browser.use/v1` or
  `cerebellum:computer.use/v1` for the specific contract the tool follows.
- **`ctx_reduce`'s name and schema are frozen for v1.** The Claude Code gateway
  grants stamping only to a tool whose wire name and schema both match (§4), so
  `ctx_reduce` keeps its catalog name and its structural schema
  (`schema_digest` `69c7dd33…`) for all of v1. Any change to either ships in
  one release window together with the matching gateway change (decision 11).
  The generator refuses a `ctx_reduce` schema with any other digest.
- **No `replace`.** A hook may add text around a Magic Context result but never
  replace it. `ctx_expand` and `ctx_search` return the archived record, and the
  guidance tells the model to trust it as the exact wording. A replaced result
  would make that false. This only declares what the tools accept. No provider
  gets `replace` by default anyway (D §3.8 line 123).
- **Never served:** the module's internal `transform` tool, which is filtered
  out of the session tools today (`crates/mc-module/src/prompt_surface.rs:226-233,302-307`).
  Also `ctx_memory_list`, which only the dreamer, Magic Context's own internal
  agent, registers and runs (`packages/plugin/src/plugin/tool-registry.ts:179-186`;
  `packages/plugin/src/tools/ctx-memory/tools.ts:462-466`). Magic Context
  composes its internal agents itself (D §4.5 line 223).
- **Descriptions.** With `tool_descs: full` they are the plugin's constants:
  `packages/plugin/src/tools/ctx-reduce/constants.ts:1-6`, `ctx-expand/constants.ts:1-11`,
  `ctx-note/constants.ts:1-16`, `ctx-memory/constants.ts:4-14` and
  `ctx-search/constants.ts:2-18`. With `concise` they are
  `packages/plugin/src/tools/light-descriptions.ts:1-13`. Parameter descriptions
  come from `packages/plugin/src/tools/parameter-descriptions.ts:3-81`. A
  user-tier `prompt_surface.tool_descriptions` override replaces a tool's
  description. Project config can't set one (`packages/plugin/src/config/project-security.ts:37,474-486`).
- **Schemas.** Each schema is flat (no root union; TP §3), with
  `additionalProperties: false`. Light and full schemas differ only in
  description text, so they share every `schema_digest` (checked by the
  generator: the `primary-light` digests equal `primary-full`'s).

**How the v1 schemas differ from what is advertised today.** The plugin's
zod shapes and the Rust module's `json!` schemas already disagree, so v1 has to
choose. Each choice keeps what the handlers already enforce.

| Tool | v1 | Plugin today | Rust module today |
|---|---|---|---|
|---|---|---|---|
| `ctx_reduce` | `drop` string, required, no extra properties | `drop` optional (`ctx-reduce/tools.ts:53-58`) | same as v1. Magic Context advertises this exact shape (`prompt_surface.rs:241-257`), and the gateway authorizes `ctx_reduce` calls against it (`classify_ctx_reduce_tool`, thalamus `crates/thalamus-core/src/tool_surface.rs:43`), so v1 keeps it unchanged, and freezes it. |
| `ctx_expand` | `tag` number or string; `start`, `end` and `message` integers ≥ 0; `verbose` | plain numbers, no bounds | as v1, but `additionalProperties: true` (`crates/mc-module/src/lib.rs:18203-18215`) |
| `ctx_note` | Rust bounds; no `memory_project` | no bounds on `limit` or `offset` | adds `memory_project`, `additionalProperties: true` (`lib.rs:18217-18232`) |
| `ctx_memory` | `category` enum of the five categories; `ids` integers ≥ 1, at most 100; bounds on `content` and `reason` | category enum, no bounds (`ctx-memory/tools.ts:394-419`) | free-string category, plus `id`, `target_id`, `source_ids` and `memory_project` (`lib.rs:18120-18172`) |
| `ctx_search` | `query` required, at most 1,024 bytes; `limit` 1–25, default 10; `sources` enum | `sources` advertised, nothing required (`ctx-search/tools.ts:68-83`) | no `sources` property even though the handler reads it (`lib.rs:16030`); `limit` default 8 (`lib.rs:18188`, `12936-12939`) |

Calls carrying a legacy field keep working on today's routes. On a
`tool-provider/v1` route, an argument outside the served schema is refused after
coercion, as AFT does (decisions 6–8).

### 2.3 The system text

`system_text.text` is the plugin's `buildMagicContextSection` output
(`packages/plugin/src/agents/magic-context-prompt.ts:160-210`). Its inputs are
mapped as follows:

| Builder input | Taken from |
|---|---|
| `ctxReduceCallable` | `ctx_reduce` is listed under `magic-context` in the composition; always false under `tools-only` |
| `subagentMode` | preset `subagent` |
| `memoryEnabled` | user or project config `memory.enabled` **and** `ctx_memory` listed in the composition |
| `dreamerEnabled` | config: the dreamer is configured and not disabled (`packages/plugin/src/config/agent-disable.ts:11-13`) |
| `temporalAwarenessEnabled` | config `temporal_awareness` (default on) |
| `cavemanTextCompressionEnabled` | config `caveman_text_compression.enabled` (default off) |
| `language` | config `language`; the directive stays last (`magic-context-prompt.ts:190-191,197-209`) |
| `preset` (light or full) | the `surface` resolution above |
| `primaryOverride` | `prompt_surface.guidance_override_path`: a file of the user's own replacement guidance, settable only in user config, read once per resolution (`prompt-surface-runtime.ts:142-185`) |

- **Subagents.** A subagent whose composition lacks `ctx_reduce` gets
  `text: ""`. OpenCode gives such a subagent no guidance today
  (`system-prompt-hash.ts:358-359`). The runner's join skips an empty `text`,
  so no stray separator appears (decision 12).
- **Self-tag guidance.** The "Start the text of each reply with exactly §N§"
  paragraph appears only in the variants with `ctx_reduce`, because only those
  sessions have tagged messages (`magic-context-prompt.ts:155-156,181,207,209`).
  So `tools-only` never carries it.
- **No date, no ids, no counts.** The text has no date line, session id, agent
  name or count. The Rust module's `guidance.get` appends `Today's date: …` per
  session (`lib.rs:9422-9451,15377-15379,5555-5566`); that moves to the head of
  m0 (§3.2, decision 5).
- **Text-only fetches.** If a plan names Magic Context only as a system-prompt
  provider, it is fetched with `params: {}`, as FP's text-only shape requires
  (FP README lines 154–159). Magic Context then serves its tools for the default
  params. The runner checks those names against Magic Context's composition
  entry, which is the staleness guard (D §4.5 line 257).

### 2.4 Session-level capabilities

None. `late_results` is not declared, because every Magic Context tool settles
inside its reply. `host_params` is not declared, because no v1 parameter is
host-only: the project comes from the route stamp's `project_root`, never from
an argument (D §9.4 line 989; decision 7). Magic Context therefore
serves neither `tool.withdraw` nor `late_results` (TP §1).

### 2.5 Digests

All digests are SHA-256 written as 64 lowercase hex characters.

| Field | Over |
|---|---|
| `schema_digest` | JCS of the structural schema: `description` removed from every schema object (TP §3; `catalog.rs:340-366,375-431`). |
| `composition_digest` (top level and in `system_text`) | JCS of the request's `composition`, exactly as sent (TP §3; E line 151). Absent on a preflight call, which carries no composition. |
| `system_text.item_digest` | The UTF-8 bytes of `text`. |
| `system_text.tool_names` | The sorted, deduplicated names of tools in the same answer. The composition's Magic Context entry must match these names when supplied. Present whenever `system_text` is present, including empty text. Tool-provider 0.4.5 runners refuse a mismatch as `plan_stale` (`text_tool_names`); Rust tests and the generator check this invariant. |
| `system_text.preflight_digest` | JCS of `{format: "magic-context/preflight/1", preset, params, config, text_revision}`, where `preset` and `params` are the text item's, `config` is the resolved inputs listed in `mc-tool-catalog-v1/config.json`, and `text_revision` hashes every model-facing string the build ships: JCS of `{texts, descriptions, parameters}` from the shared definition, where `texts` is every guidance template and fragment, the two tools-only texts included. The generator fails when a guidance asset in `crates/mc-module/assets/` is not covered. It doesn't depend on the composition. |
| `catalog_digest` | JCS of the answer without `generation` and `catalog_digest`: `composition_digest`, `tools` and `system_text` when present. A `digest_only` request with the same inputs gets the same value (TP §3). |
| `generation` | Equal to `catalog_digest`, as AFT does. Opaque to consumers. |

`text_revision` sits inside `preflight_digest` on purpose. A deploy that only
rewords guidance changes no config, yet the owner's turn-boundary check must
still see it (§4).

### 2.6 Wire bytes

Magic Context serves the answer as its JCS bytes. The `.answer.jcs` files are
those bytes; the `.answer.json` files are the same values pretty-printed for
reading. The module writes them with `serde_jcs`, the RFC 8785 canonicaliser the
tool-provider crate computes its digests with, so a composition holding floats
or non-ASCII keys still hashes as JCS. Its tests compare each answer with these
files byte for byte.

The generator re-checks its JCS and structural-schema code on every run. It
reproduces every vector without floats in TPV's `composition-digest.json` and
`schema-digest.json` (commons at `42949fc3`), and every FP composition and plan
whose `.json` canonicalises to its `.jcs` and hashes to its `.sha256`
(prefrontal at `35c8e5f7cec5b5fc3564f51f9888b2e290c0c023`). It reads both repositories with `git show` from
next to this repository's main checkout, and says so when it skips one.
The prefrontal vectors include `plans/broca-head-no-compaction`, whose
Magic Context `tools-only` entry contains only `ctx_memory`, `ctx_note` and
`ctx_search`, with no step-transform items.

### 2.7 The examples

All examples resolve against one config (`mc-tool-catalog-v1/config.json`):
compaction on, memory on, dreamer configured, temporal awareness on, caveman
off, no language, `prompt_surface.default: full`, one model entry
(`anthropic/claude-haiku-4-5` → `light`), no override. With those flags the
`primary`, `primary-light` and `no-reduce` texts equal the Rust module's shipped
assets byte for byte (`crates/mc-module/assets/guidance_primary.txt`,
`guidance_light_primary.txt` and `guidance_no_reduce.txt`); the generator
compares them on every run, and checks that `guidance_light_no_reduce.txt`,
which no example uses, is the definition's light no-reduce text.

The following table records the historical r2 examples. Current role-named
examples and their changed digests are in the role update report linked above.

| Historical example | Request | Old `catalog_digest` → r2 `catalog_digest` | Text (`item_digest`, UTF-8 bytes) |
|---|---|---|---|
| `preflight` | `primary`, no composition, no text | `4dbfd638576261155e2f10b6dddfbd16ba652da5529e8a978b0ca625e2a994f2` → `4dbfd638576261155e2f10b6dddfbd16ba652da5529e8a978b0ca625e2a994f2` | none |
| `primary-full` | a head with AFT's tools, Magic Context's five and Prefrontal's forwarding tools; `ctx_reduce` is present, so the guidance text is included | `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` → `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` | `ee720eeb…`, 6,016 |
| `primary-full.digest-only` | same, `digest_only: true` | `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` → `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` | none |
| `primary-light` | `tool_descs: concise`, `surface: light` | `bf46a16344d6869af44648fb17a990aef33746ed46687bdeaa39914b73677a39` → `bf46a16344d6869af44648fb17a990aef33746ed46687bdeaa39914b73677a39` | `f03cec64…`, 4,736 |
| `subagent` | `subagent`, AFT and MC only | `a297c427e1f4e821bb134081d8965f34a30c5abe0a98f2f00196b941de316f55` → `a297c427e1f4e821bb134081d8965f34a30c5abe0a98f2f00196b941de316f55` | `561c5cb3…`, 2,249 |
| `no-reduce` | `primary`, `exclude: ["ctx_reduce"]`; the composition lacks it | `f3fb053c5bbc680734978aee427804ec443a0114eea9a5f417f8e438a6346c62` → `f3fb053c5bbc680734978aee427804ec443a0114eea9a5f417f8e438a6346c62` | `80e42ffa…`, 4,221 |
| `tools-only` | `tools-only`, no params; the composition lists only `ctx_search`, `ctx_memory` and `ctx_note` | `9b776859dbfece430c08a798e4dd3dff0be9802d7fd2b88282e3adbedc7bd098` → `460bf7b2b492835d15e29855833f2134a079dac5ab190a48f6f9d6d1c0f0a91b` | `73c67970…`, 802 |
| `tools-only-light` | `tools-only`, `model: anthropic/claude-haiku-4-5` on both items, which the config maps to light | `e5ad1e0995f6985cfcca1e8dd15f125f9ae78f7c7b370f4d6a2c6c5a3db2554d` → `1f0295dcc087dac9f7cbd21557d53a35fed395e8560481fdfcccc15bccd7158c` | `7ab35687…`, 675 |

`tools-only` serves three tools; `no-reduce` also serves `ctx_expand` and
uses different text (§7.2). The full and light `tools-only` examples differ in both the text and
every tool description.

Each example has `<name>.request.json`, `<name>.answer.json` and
`<name>.answer.jcs`, plus `text/<name>.txt` holding the exact text with no
trailing newline. `.gitattributes` keeps both byte-exact files from being
rewritten on checkout. The compositions follow FP's canonical order (providers,
tools and tags sorted bytewise; FP README lines 262–271). The AFT entries carry
the tags AFT's catalog declares for those tools (`crates/aft/src/subc/tool_provider.rs`,
`METADATA`), all of them among the defined unprefixed tags.

## 3. Variation and purity

### 3.1 Every way the bytes vary today, and where each goes

| Varies today by | Today's source | Allowed under the purity rule? | Under this plan |
|---|---|---|---|
| Light or full surface | `prompt_surface.default` and `.models[model key]`; per session and model epoch on OpenCode (`system-prompt-hash.ts:360-369`; `prompt-surface-runtime.ts:258-283`), once per process for the OpenCode 1 and Pi tool maps (`tool-registry.ts:196-201`) | The model isn't an input; config and params are. | Params `tool_descs` and `surface`, or the `model` param looked up in MC's own config (decision 4). Frozen with the plan; a model switch applies at the next refresh. |
| Model family or serializer profile | `guidance.get` picks the tagged variant from `serializer_profile` plus `tool_present` (`lib.rs:9391-9411,1332-1334`) | No. | Removed. The composition says whether `ctx_reduce` is present. |
| Tags on or off | The same thing as `ctx_reduce` being callable: tags exist only where stamping does (`magic-context-prompt.ts:173-182,200-209`) | Only through the composition. | `ctx_reduce` in MC's composition entry. |
| `ctx_reduce` denied by agent or session permission | Read from OpenCode's agent and permission config before the verdict freezes (`packages/plugin/src/hooks/magic-context/ctx-reduce-availability.ts:6-44`) | No: agent identity. | The session's starter (Prefrontal, or the gateway when it plans) leaves `ctx_reduce` out, through `exclude` or by not composing it, and the text follows the composition. A user-tier disable by exact name makes it absent from the catalog (D §9.2). |
| Compaction off | `compaction.enabled: false` drops `ctx_reduce` (`tool-registry.ts:84-85,141-152`) | Yes, config. | Unchanged. `ctx_reduce` is absent from the catalog. |
| Which provider compacts | Nothing today: wherever Magic Context is loaded it compacts, and the guidance assumes so | Yes: the preset, which core's plan builder chooses from the plan's `compaction_item`. | Preset `tools-only` when another provider compacts or none does: no `ctx_reduce` or `ctx_expand`, the tools-only text (§7.2). |
| Subagent | `isSubagent` in session metadata (`system-prompt-hash.ts:334-359`) | No: session state. | Preset `subagent`, which core sends for bounded readers and one-shot calls (decision 1). |
| Memory off | `memory.enabled` drops `ctx_memory` and the pinboard paragraph (`tool-registry.ts:129-178`) | Yes, config. | Unchanged, and the paragraph also requires `ctx_memory` in the composition. |
| Dreamer, temporal awareness, caveman | Config flags passed to the builder (`system-prompt-hash.ts:376-388`) | Yes, config. | Unchanged. |
| Language | Config `language`; the name is resolved by `Intl.DisplayNames` in TS (`packages/plugin/src/agents/language-directive.ts:19-39,117-121`) and by a fixed table in Rust (`crates/mc-module/src/content_language.rs:4,181`) | Yes. A project picking a code selects among shipped texts. | Unchanged. One shared name table (decision 13). |
| Guidance override, tool-description overrides | User-only config; a project can't set them (`project-security.ts:37,474-486`) | Yes, user config. | Unchanged. The override file's SHA-256 enters `preflight_digest`. |
| Date line | Rust appends `Today's date: …`, frozen per session in MC's store (`lib.rs:9422-9451,9473-9512`). OpenCode and Pi freeze the host's own date line (`system-prompt-hash.ts:412-465`; `packages/pi-plugin/src/system-prompt.ts:104-119`). | No: time, per session. | Out of the catalog; no runner adds or expects a date in system text. On runner-driven sessions (Broca, Claude Code) Magic Context puts the sticky date at the head of m0, advanced only when m0 is rebuilt anyway, which is today's sticky-date rule. On OpenCode and Pi the host's line stays the host's (decision 5). |
| Session id and binding | `guidance.get` and `manifest.get` require `session_id` and freeze the selection per session (`lib.rs:9302-9349,9356-9405`) | No. | Removed. The runner freezes what it fetched (D §4.5 line 241). |
| Memories, history, project docs, profile, key files | Already m0 and m1, never system text (`system-prompt-hash.ts:403-408`; D §4.3 line 186) | Never catalog text. | Unchanged. They stay with compaction. |
| Steers, nudges, reduction reminders | Channel 1 and 2 reminders and the transform's own text | Not system text. | Unchanged: they stay with the step transform and compaction, as user-role text (D §15 line 1746). |

### 3.2 What has to move

1. **The date line**, out of the Rust guidance bytes and into the head of m0 on
   runner-driven sessions. That is the only case where today's system text
   carries time.
2. **The tagged or no-reduce choice**, from the serializer profile and agent
   permissions to the composition.
3. **The subagent choice**, from session metadata to the preset.
4. **The compaction fact**, from an assumption in the guidance to the preset:
   `tools-only` when Magic Context doesn't compact.
5. **The per-session freeze** in `guidance.get` and `manifest.get`, from Magic
   Context to the runner's frozen manifest. Thalamus's in-process freeze
   (`thalamus/crates/thalamus-module/src/guidance_client.rs:1-18`) becomes the
   gateway's frozen plan (D §14.1 lines 1513–1531).

Nothing Magic Context serves needs late results. Live material reaches the
model only through compaction (m0 and m1) and step transforms, never the catalog.

## 4. Composition with peers

- **The text reads only Magic Context's own entry**, the one whose `provider`
  is Magic Context's registered module id, `magic-context`
  (`lib.rs:245`). It reads that entry's tool names. Nothing else in the
  composition affects v1's bytes, so the composition can't change a schema or
  a tool name (D §4.5 line 213).
- **Richest satisfied variant, within Magic Context.** With `ctx_reduce`, the
  stamping text. Without it, the no-reduce text, which never mentions tags. With
  `ctx_memory`, the pinboard paragraph; without it, none. The `primary` and `subagent` texts require
  `ctx_expand`, `ctx_search` and `ctx_note`. The `tools-only` texts require only
  `ctx_search`, `ctx_memory` and `ctx_note`. A session missing a required tool
  has no shipped text, and both Rust and the generator refuse that request.
- **Across peers, adaptation is by tag and never required.** v1 ships no
  peer-dependent sentence. The mechanism for later is fixed now so peers can
  plan around it:
  - A peer clause is one sentence, appended at a fixed point after the base
    text and before the language directive. It is included only when its tag
    matches.
  - Matching is unpinned by default: the tag on a tool from any provider, such
    as `code.outline/v1`. It is pinned to one provider (the same tag on a tool
    in the `aft` entry) only when the sentence relies on that provider's exact
    behaviour, such as AFT's line-tag format in `read` (D §4.5 line 215). A
    provider's own namespaced tag, such as `aft:code.ast_grep/v1`, needs no
    pin: only AFT ships it.
  - When the tag is absent, the clause is dropped and the base text stands.
    Magic Context never refuses a composition for a missing peer (D §4.5 line 216).
  - Each clause is a new shipped string, so adding one changes `text_revision`
    and follows §5.
- **The other direction.** Peers that want to mention stamping or recall match
  `magic-context:context.reduce/v1` or `magic-context:archive.search/v1`.
  Prefrontal's persona and AFT's guidance can then say "stamp outputs you are
  done with" only when the session can.
- **Claude Code path (b).** The gateway plans from wire tool names, which carry
  no tags (D §14.1 line 1509), and maps forward, never parsing a wire name back
  (decision 11):
  - For each tool in Magic Context's catalog it expects exactly
    `mcp__subc__magic-context_<catalog name>` among the session's tools. The
    ones present go under `magic-context` by catalog name, with the catalog's
    tags.
  - `ctx_reduce` counts as present only if its wire name and its schema both
    match, through the same predicate as the gateway's reduce authority gate
    (`classify_ctx_reduce_tool` in thalamus `crates/thalamus-core/src/tool_surface.rs:43`,
    exact name at :16). A drifted `ctx_reduce`
    is left out of the composition and excluded from the fetch, so the session
    gets the no-reduce text and never a stamping text without working drops.
    That is why `ctx_reduce`'s name and schema are frozen for v1 (§2.2).
  - The preset is `subagent` when the request carries
    `x-claude-code-agent-id`, and `primary` otherwise.
  - D line 1508 calls the text for a session without the reduce tool "light".
    In Magic Context's terms that is the no-reduce variant; light is a
    surface. The design text says "no-reduce".

## 5. Change policy

### 5.1 What a deploy costs today

- **OpenCode and Pi.** A guidance or preset change alters the persisted
  system-prompt hash. On each live session's next turn that triggers history
  refresh, system-prompt refresh and re-materialization: one full prefix rebuild
  per session (`system-prompt-hash.ts:492-504`; Pi: `system-prompt.ts:95-119`).
  So a fleet restart onto new guidance costs one prefix rebuild per live session.
- **Claude Code.** Thalamus freezes guidance per session in process memory
  (`guidance_client.rs:9-14`). A deploy reaches a live session after a Thalamus
  restart, when every session refetches. Any byte difference then busts the
  trailing system blocks.

### 5.2 Under the frozen manifest

- A deploy changes what new sessions fetch. Live sessions keep their frozen
  bytes (D §4.5 lines 241–242).
- At a head's turn boundary, the owner calls `tool.catalog` with
  `digest_only: true` and the frozen plan's request (decision 10). It sees a new
  `catalog_digest`, because `text_revision` moved. The owner preflights again
  and sends `session.refresh` under its policy (D §13.1–13.2). The head
  default, `on_prefix_rebuild`, applies the change at the next dead prefix (TTL
  expiry, model switch or flush), at **zero extra cost** (D §13.2 lines 1377,
  1408). Workers and readers have no turn-boundary check and keep their launch
  bytes (D §13.1 line 1368).
- A model switch changes no fetched byte on its own: the `model` param is
  frozen with the plan. The switch applies at the next refresh, whose request
  carries the new model (decision 4).
- Magic Context asks owners to use `on_prefix_rebuild` for its wording changes,
  and `on_system_rebuild` only for a correction that can't wait. On Broca an m0
  rewrite, which Magic Context makes at every fold, already invalidates from m0,
  so that rung costs only system and tools.

### 5.3 Appends versus rebuilds

| Change | How it reaches a live session |
|---|---|
| A new Magic Context tool | Appended as a tool addition under `immediately` where the session has `mid_session_appends`; otherwise at a fold. Other providers' text understates it until then, which is safe (D §4.5 line 218). |
| A tool disabled or removed | Refused at once as `tool_disabled` (D §9.2). The model stops seeing it at a fold. Applying a removal as an append, without a fold, hasn't been measured on Claude Code (D §14.1 line 1560). |
| Guidance text | **Fold only, never an append.** An appended second guidance block would contradict the frozen one without replacing it, and the text is operator authority (D §15 line 1745). |
| A description reworded | Fold only. Pins are unaffected: `schema_digest` ignores descriptions (D §9.3 line 974). |
| An argument added | Fold. Old pins stay servable because argument changes are additive (TP §4). |
| Behaviour changed with the same schema | Bump `semantics`. A call pinned to the old value is refused `tool_semantics_changed` only if the old behaviour can't be honoured. |
| `ctx_reduce`'s name or schema | Frozen for v1. A change ships in one release window with the gateway change that recognises it; otherwise Claude Code sessions silently lose stamping (decision 11). |
| A config edit (memory off, surface, language) | Detected by `preflight_digest` or `catalog_digest`, then applied at a fold. |

Magic Context adds no WAL record kinds. What it serves sits inside the runner's
`RunStarted`, `manifest_pending` and `prefix_rebuilt`, which the reader gate
already covers (D §15 lines 1771–1772).

## 6. Parity

**Target:** one definition of tools and text, giving the same bytes wherever a
runner fetches the catalog (Broca, and Claude Code through the gateway), and the
same structure and words where the host registers tools itself (OpenCode, Pi).

| Surface | Today | Under this plan |
|---|---|---|
| Broca | No caller of `guidance.get` found in broca or prefrontal, though the module has an `OwnedBroca` branch for one (`lib.rs:9406-9410`). | Fetches `tool.catalog`; the bytes are these files. |
| Claude Code (Thalamus, ck-mc) | Tools come from the module's manifest (`prompt_surface.rs:206-300`), text from `guidance.get` (`guidance_client.rs:32-46`; no `language` is sent). | The gateway fetches `tool.catalog` for the text, and subc-mcp serves the catalog's tools as `mcp__subc__magic-context_<catalog name>`. The bytes are the same as Broca's. |
| OpenCode | Tools registered natively; the host converts the zod shapes. Guidance is appended to `system[0]` after a blank line (`system-prompt-hash.ts:28,396`). | The same shared definitions. OpenCode serializes them into its own JSON Schema, whose exact bytes Magic Context doesn't control. |
| Pi | The same builder, `subagentMode` always false (`packages/pi-plugin/src/system-prompt.ts:63-86`). | The same definitions; subagent text when Pi gains subagents. |

Gaps found while preparing this plan:

1. **The Rust guidance is fixed to one config.** The four assets equal the TS
   builder only with dreamer, temporal awareness and memory all on and caveman
   off. On Claude Code the text claims smart notes and time markers even when
   they are off, and has no subagent variant (`prompt_surface.rs:15-21,170-189`).
2. **`ctx_search`'s Rust description lacks the `primer` line**
   (`lib.rs:18079-18084` against `ctx-search/constants.ts:12-18`), although the
   handler accepts `primer`.
3. **The schemas differ** as tabled in §2.2.
4. **Language names** come from ICU in TS and a fixed table in Rust.

The fix is one shipped definition read by both languages: tool structures,
descriptions and guidance fragments in one asset set, as the Rust module already
does for the four guidance assets. That definition is
`crates/mc-module/assets/tool_catalog_v1.json` with the two tools-only texts
beside it. The module's `tool.catalog` serves from it, the generator builds
these examples from it and checks it against the plugin's strings, and a golden
test in the module pins these example files. The plugins do not read it yet.

## 7. Decisions

The extensibility room reviewed r1's fourteen questions. Each entry gives the
question, the answer and who ruled. *Adopted* means nobody in the room objected
to r1's recommendation, so it stands as written.

### 7.1 Decided

1. **Preset names.** FP's vectors use `head` for Magic Context. *Ruled by the
   room:* Magic Context defines `primary` and `subagent`. Core maps heads and
   masons to `primary`, and bounded readers and one-shot calls to `subagent`.
   Magic Context never knows the role. FP's `head` is an illustrative name
   (§2.1).
2. **Is Magic Context the session's compaction provider?** The stamping text
   and the self-tag paragraph are true only if Magic Context's transform tags
   the session. *Ruled by the room:* the composition doesn't name the
   compaction provider. Core sends `primary` or `subagent` only when the plan's
   `compaction_item` names `magic-context`. Otherwise it sends a third v1
   preset, `tools-only`: no `ctx_reduce`, its own text (§7.2), and no stamping or
   self-tag guidance. Core's plan builder refuses any other pairing (§2.1;
   examples `tools-only` and `tools-only-light`).
3. **Sessions without `ctx_expand`, `ctx_search` or `ctx_note`.** The user
   tier may disable any tool (D §9.2), but every shipped text names these three.
   *Adopted:* before Magic Context declares `tool-provider/v1`, the text is
   split so each sentence that names one of them is dropped when it is absent,
   pinned by goldens. Until then the generator refuses such a composition.
4. **The model as an input.** Today the surface follows the live model per
   session, and the purity rule has no model input. *Ruled by the room:* an
   optional `model` param, frozen with the plan, used only to look up Magic
   Context's own `prompt_surface.models`. A model switch applies at the next
   refresh (§2.1, §5.2; example `tools-only-light`).
5. **Where the date goes.** *Ruled by BROCA:* no runner adds or expects a date
   in system text. The sticky date moves to the head of m0 on runner-driven
   sessions; OpenCode and Pi keep the host's line (§3.1).
6. **`ctx_search` default limit.** The handler uses 8; the descriptions and
   the plugin say 10. *Adopted:* 10, and the handler changes.
7. **`memory_project`.** It is advertised to the model as "supplied by the host
   transport". *Adopted:* dropped from the v1 schema; the project comes from
   the route stamp, so v1 declares no `host_params` (§2.4).
8. **Legacy argument forms** (`id`, `target_id`, `source_ids`, extra fields).
   *Adopted:* not advertised. Refused on `tool-provider/v1` routes after
   coercion, and still accepted on legacy routes until they retire.
9. **Unprefixed tags.** *Ruled by AFT:* the unprefixed standard names are
   defined in tool-provider §3 on commons master (eight in
   cortexkit-role-tool-provider 0.4.2; 0.4.3 adds `browser.use/v1` and
   `computer.use/v1`), together with the tag-shape rule
   `<namespace>:<name>/v<N>` for every other tag. Magic Context ships only
   `magic-context:*` tags, and every tag in the payloads passes the crate's
   `check_capability_tag` (§2.2).
10. **`preflight.digest`.** D §4.2 and §13.1 name `preflight.digest(cwd,
    params)`, but TP has no such op. *Ruled by the room:* owners use
    `tool.catalog` with `digest_only: true` and the frozen request. There is no
    `preflight.digest`, and Magic Context serves no separate op (§5.2).
11. **Claude Code path (b) composition.** *Ruled by THALAMUS:* the gateway maps
    forward. It expects exactly `mcp__subc__magic-context_<catalog name>` for
    each catalog tool and never parses wire names back. `ctx_reduce` counts as
    present only if its name and its schema both match, through the same
    predicate as the gateway's reduce authority gate, so a drifted `ctx_reduce`
    gets the no-reduce text, never stamping without drops. Magic Context takes
    on one rule in return: `ctx_reduce`'s catalog name and schema are frozen for
    v1, and any change ships in one release window with a gateway change. The
    preset is `subagent` when the request carries `x-claude-code-agent-id`, and
    `primary` otherwise. The design text says "no-reduce", not "light", for the
    variant without `ctx_reduce` (§2.2, §4, §5.3).
12. **Empty subagent text.** *Ruled by BROCA:* Magic Context answers
    `text: ""`, and the runner's join skips an empty `text`, so no stray
    separator appears. An empty text and an absent text item are recorded
    differently in `RunStarted` but render the same. The join rule is frozen
    per session (§2.3).
13. **Language names.** *Adopted:* one shipped table for both languages, so
    the bytes don't depend on the host's ICU version.
14. **`result_ops`.** *Adopted:* `prepend` and `append` on all five tools, for
    the reason in §2.2. No planned hook asked for `replace` on a Magic Context
    tool.

### 7.2 Decided by Magic Context after the room review

One item, found while applying decision 2. Owner and ruler: Magic Context.

- **The no-reduce text describes Magic Context's own compaction.** It was
  written for a session Magic Context compacts while the model can't stamp. It
  says that "Magic Context compacts in the background", that Magic Context files
  older work as `<session-history>`, and that `ctx_expand(message=N)` brings a
  cleared item back whole. Under `tools-only` another provider compacts, or
  none does, so those sentences describe machinery the session doesn't have.
  *Decided:* `tools-only` serves exactly `ctx_search`, `ctx_memory` and
  `ctx_note` on both surfaces, and gets its own text. It serves neither
  `ctx_reduce` nor `ctx_expand`: there are no Magic Context tags or
  `<session-history>` headings to expand, and a runner such as Broca does not
  expose the session's raw history to Magic Context. Magic Context renders nothing into
  a `tools-only` session (no m0 or m1, no `<project-memory>`, no tags, markings
  or clearing), so the text drops every sentence about those: the desk and its
  tags, the long-term-partner frame, the history filing, the markings, the
  caveman warning and the temporal markers. It keeps the `ctx_search` paragraph
  without its pointer to filed history, the `ctx_note` tray, and a rewritten
  `ctx_memory` paragraph that says pinned facts are recalled with `ctx_search`
  rather than shown. It reuses the existing sentences where they are still
  true and adds plain new ones where none is. The text is its own asset
  (`crates/mc-module/assets/catalog_tools_only.txt` and
  `catalog_tools_only_light.txt`); the examples `tools-only` and
  `tools-only-light` show its bytes. It is in place before Magic Context
  declares `tool-provider/v1`; until then no session is served `tools-only`.
  The text is Magic Context's to choose, since it reads only Magic Context's
  own entry, so the room needs no ruling.

## 8. What implementing this would touch

This section is for scoping only; the room isn't asked to approve it.

- `crates/mc-module`: a `tool.catalog` handler and a `role.describe` answer
  (TP §2). The answer is built from the shared definition, the date moves to the
  head of m0 on runner-driven sessions, the `ctx_search` handler's default limit
  becomes 10, and `guidance.get` and `manifest.get` stay for legacy callers until
  they retire. Magic Context lists `tool-provider/v1` in its manifest's
  `capabilities.provides` only in the slice that completes decision 3's text
  split; until then callers reach `tool.catalog` and `role.describe` by name on
  its tool route.
- `packages/plugin` and `packages/pi-plugin`: read the same definition, and use
  the reconciled schemas.
- Conformance: run `cortexkit-role-tool-provider-conformance` against the live
  module. Magic Context declares no held calls, so the withdraw and late-result
  cases are skipped by capability.
- Outside Magic Context, the decisions above need: core's plan builder choosing
  the preset from `compaction_item` and refusing other pairings (decisions 1
  and 2), the gateway's forward name map and `ctx_reduce` predicate (decision
  11), and Broca's join rule for empty text (decision 12).
