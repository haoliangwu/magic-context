# Broca transform contract (`owned-broca`)

For the Broca and prefrontal owners. It covers what a Broca-hosted session must pin
before Magic Context's transform is switched on for it, and what the module does to
each send. Nothing here is enabled yet. The claims are pinned by
`crates/mc-module/src/tests/broca_contract.rs`.

## 1. The facade tool array

**Source.** The Rust module owns its own copy of the five facade tools:

- names, schemas, and the full-preset descriptions: `ctx_*_description()` and
  `ctx_*_schema()` in `crates/mc-module/src/lib.rs`, plus `CTX_REDUCE_DESCRIPTION`
  in `crates/mc-module/src/prompt_surface.rs`;
- light-preset prose: `TOOL_LIGHT_DESCRIPTIONS` and `schema_with_preset_descriptions`
  in `prompt_surface.rs`;
- assembly: `prompt_surface::module_tools` / `session_tools`.

`packages/plugin/scripts/export-agent-surface.ts` exports the OpenCode plugin's
TypeScript tools. Those are a separate copy and are **not** what a Broca session gets.

**Goldens.** The exact array a Broca mason declares:

- `crates/mc-module/testdata/broca-facade-tools-full.json`
- `crates/mc-module/testdata/broca-facade-tools-light.json`

Order: `ctx_reduce`, `ctx_memory`, `ctx_expand`, `ctx_search`, `ctx_note`. Object keys
are sorted. Each entry has `name`, `description`, `schema` (the provider's input
schema) and `execution_mode` (a subc field; don't send it to the provider). Sorting
by name on the caller side is fine as long as it happens once. The test fails if
the array served by `manifest.get` drifts from the goldens, by value or by byte. To
regenerate the goldens deliberately, run
`MC_BLESS_BROCA_FACADE_GOLDENS=1 cargo test -p mc-module --lib broca_contract`.

**What changes the array:**

| Input | Effect |
|---|---|
| Preset `full` / `light` | Tool and parameter descriptions only. Names, types, `required` and enums are identical. |
| `tool_descriptions` overrides (user config `prompt_surface.tool_descriptions`) | Replaces a tool's top-level description. Broca callers must not send any. |
| Module rebuild with changed copy | New bytes on the next `manifest.get`. The goldens make this a reviewed change in this repo. |
| `memory.enabled` | No effect. `ctx_memory` is always present (pinned by test). |
| `ctx_memory_list` | Never present. It exists only in the Pi plugin for dreamer children. |
| Startup (HELLO) manifest | Same full-preset definitions plus the internal `transform` tool. Never declare `transform` to a model. |

The schemas of `ctx_memory` and `ctx_note` advertise a `memory_project` property that
the host transport fills in. The model sees it. It is part of the golden bytes.

**Picking the preset.** Send `{"kind":"manifest.get","session_id":…,"preset":"full"|"light"}`
on the session's bound route. Omitting `preset` gives `full`. The module caches the
selection per session only in process memory (`freeze_prompt_surface_selection`,
keyed by session, `model_key` and `config_identity`). A module restart forgets it, a
request with another preset selects again, and transform requests write to the same
cache (Broca's transform sends no preset, which means `full`). So the module-side
cache is **not** a pin. The caller picks the preset once per session, stores the
array it got on the first send, and re-declares exactly those bytes on every later
send. It never fetches the array again mid-session.

If the pinned system prompt includes Magic Context guidance, fetch it with
`guidance.get` using the same preset, `serializer_profile: "owned-broca"`, and the same
`tool_present` value the session sends on every transform. With `tool_present: true`
(the tool array includes `ctx_reduce`) the module serves the reduce-capable `full`
variant; otherwise it serves `no_reduce`, which tells the model `ctx_reduce` is
unavailable. The date line is stored per session, so it stays the same for the whole
session. Fetch the guidance once, at the first send, and pin it with the system prompt.

Broca never calls `guidance.get`; the caller that pins the system prompt does. Broca
sets `tool_present` on transforms itself, derived from the session's frozen tool set,
so the caller must derive its `guidance.get` value from the same tool set it gives
Broca. If the two disagree, the guidance tells the model one thing while the module
tags (or doesn't) for the other.

## 2. What the transform does, send by send

Broca sends the loop's prompt with the pinned system prompt as the leading `system`
message (ordinal 0). The tool list is never sent to the module. The module learns
whether the tool array includes `ctx_reduce` from one boolean, `tool_present`
(missing means `false`).

**Send 1** (the session's first materialization, reported as `decision: "HARD"`). The
served array is:

```
[ <caller's system message(s)>, m[0] (synthetic user), m[1] (synthetic user), …rest ]
```

The run of `system` messages at the start of the caller's array goes first, then the
two head rows. Broca's `openai_chat` renderer, and its Responses renderer without the
instructions field, send system messages where they sit in the array, so the system
prompt has to come first. The Anthropic, Gemini, Bedrock and Responses-with-instructions
renderers lift system messages out, so the order makes no difference to them. The same
order applies with compaction off, where the module only adds the head rows. Other
profiles keep their order (`[m0, m1, …]`).

- m[0] holds `<project-docs>` (ARCHITECTURE.md / STRUCTURE.md when present),
  `<project-memory>` and the user profile when memory is enabled, then
  `<session-history>` (empty on a new session). m[1] holds `<session-history-since>`.
  Both are present from send 1 on, even when empty.
- The system message comes back byte for byte. The module adds no guidance, date
  line or tags to it and never merges m[0] or m[1] into it.

**Send 2 onward, on a replay pass** (`"SOFT+"`, the normal case). The whole
previously served prefix is replayed byte-identical and new messages are appended
verbatim.

**When the prefix changes.** Only on passes that already rebuild it:
`is_provider_prefix_mutation_pass` in `transform.rs` (plans `Hard`, `MigrateHard`,
`Soft`). This applies to `owned-broca` as to every profile. `Soft` re-renders m[1]
(new historian compartments, memory changes). `Hard` re-renders m[0] and replaces the
covered history with it. Hard is triggered by a fold, cache expiry, a `render_config`
change, or context pressure. Tail reclaim and queued drops also land only on these
passes (`tail_reclaim(OwnedBroca)` is true). The leading system message survives a
fold as long as it comes before the first covered ordinal
(`is_uncovered_leading_system`). If a fold ever covers it, Broca's `run.rs` re-adds
the durable leading system messages.

**Tags.** A session that sends `tool_present: true` gets the same tag overlay as an
OpenCode session with `ctx_reduce`. A session that omits it, or sends `false`, never gets
a `§N§` tag. With tags on:

- A message is tagged the first time the module sends it, on any pass. On send 1 that
  is every user, assistant-text and tool-result message in the array. Later sends tag
  only the messages they append. System messages and the m[0]/m[1] head rows are never
  tagged.
- A message the provider has already seen is never tagged on a replay (`SOFT+`) pass.
  If the module mints a tag for such a message (for example one that Broca served raw,
  as its last-known-good array plus the raw tail after a failed transform), the tag
  waits in `pending_tag_block_ids` until a pass that rebuilds the prefix
  (`Hard`, `MigrateHard` or `Soft`).
- Switching `tool_present` mid-session changes the render identity. The next send is a
  `HARD` that tags (or untags) the whole served history at once, so tags never trickle
  into a cached prefix. Pick the value once per session anyway: each switch costs a full
  rebuild.
- Temporal markers, auto-search hints and the reduction reminder ride on the same
  overlay. Temporal markers are decided only for newly arrived messages; a hint or
  reminder aimed at an already-served message also waits for a prefix-rebuilding pass.
- `ctx_reduce` calls reach the module's facade and queue drops by tag number in the
  module's durable queue. Queued drops land on the next pass that rebuilds the prefix.

**Which caller bytes the tags change.** The caller's system messages, and so the
pinned system prompt and pinned guidance, never change. Tags do change the text of
user, assistant and tool-result messages as the provider sees them: from send 1 on, the
first user message reaches the provider as `§N§ <text>`, not as the bytes Broca sent.
Anything Broca compares between its input and the transformed array (for example,
restoring cache markers when the blocks match) sees those messages as changed. The
untransformed prompt in Broca's WAL is unaffected.

## 3. Message identity: `mid`, `ordinal` and `meta`

Each wire message carries an envelope `mid` and `ordinal` next to the CK message, and
the CK message has its own `meta.harness_id` and `meta.ordinal`.

**What the module keys on.** Durable state (tags as `mid#block`, drops, coverage,
compartments, served-prefix records) keys on the envelope `mid` and `ordinal`. The module
requires:

- `ordinal` strictly increasing across non-synthetic messages in each request (a
  repeat or a decrease is rejected with an ordinal violation). Gaps are allowed; the
  ordinals do not have to be contiguous.
- `ordinal` is the message's position in the session: the same message keeps the same
  ordinal on every send, and an ordinal is never reused for another message. Coverage
  is ordinal-based, so a renumbered message is treated as a different message.
- `mid` is unique within the session and stable across sends, including resumes.

**What the module does with `meta`.** It passes `meta` through unchanged on every
message it keeps, even when it rewrites the message's blocks (tags, caveman
compression, drop placeholders, skeletonized tool input) or moves it (a system message
placed ahead of the head rows). It never merges or splits caller messages, so no output
message carries another input message's `meta`. Rows the module creates (m[0], m[1],
the OpenCode-only synthetic todo pair) carry `meta.synthetic: true` and neither
`harness_id` nor `ordinal`. The module reads `meta.harness_id` (or `meta.ordinal`) only
to name blocks in its served-prefix record.

So for Broca to map the transformed array back to its input by `meta`, set
`meta.harness_id` to the envelope `mid` and `meta.ordinal` to the envelope `ordinal`
on every message. A message whose `meta` lacks them comes back without them.
`owned_broca_retained_messages_keep_their_harness_id_and_ordinal` pins this across a
coverage fold, tags, caveman, a queued drop and head-row insertion.

One path does rewrite `meta.ordinal`: a lineage descent (`lineage_switched: true`)
rebases the replacement array's ordinals. Broca does not send that field.

## 4. What a caller must pin, and never send

Pin once per session, at the first send: the preset, the tool array (from the golden
or one `manifest.get`), whether that array includes `ctx_reduce` (`tool_present`), the
system prompt, the guidance fetched with that `tool_present`, and `render_config`.

Never, mid-session:
- change, add or remove a tool, or change its description;
- switch the preset or send `tool_descriptions` or `guidance_override`;
- change `render_config` or `tool_present` (each change forces a full re-render);
- change the system message, or rewrite, reorder or re-number earlier messages (the
  module keys its state on `mid` + `ordinal`);
- declare `transform` or `ctx_memory_list`.

## 5. Gaps before enabling

Closed in the module:

1. **`ctx_reduce` under `owned-broca`.** The module tags a session whose requests send
   `tool_present: true` and serves the reduce-capable guidance for it (section 2,
   "Tags"). Broca still has to send `tool_present: true` whenever a mason's tool array
   includes `ctx_reduce`, and send the same value to `guidance.get`. Today Broca's
   transform request has no such field, so its sessions stay untagged until it does.
2. **Head rows before the system message.** The module now places the caller's leading
   system messages ahead of m[0]/m[1] under `owned-broca` (section 2, "Send 1").
4. **Broca wire fields.** The module accepts Broca's names:
   - `cache_ttl_ms` sets the TTL used to predict cache expiry, in milliseconds, when
     `cache_ttl` is absent;
   - `overflow_error_text` feeds provider-overflow detection when `provider_error` is
     absent;
   - `agent_drop_ids` is accepted and ignored, with one log line per session when it is
     non-empty. `ctx_reduce` calls reach the module's own facade and queue drops in its
     durable store, which applies them on the next pass allowed to change the prefix.
     A caller-held list would be a second record of the same drops, and Broca fills it
     with nothing today.

Open, on Broca's side:

3. **Caller cache markers are lost.** Broca's `project_transform` puts back
   `cache_prefix_blocks` only when the output has the same length and block counts as
   the input. Adding m[0]/m[1] breaks that on every send, and tags change block text.
   Broca needs to map its markers onto the transformed array by `meta` (section 3)
   before enabling.
5. **The module doesn't keep the prompt-surface selection across restarts.** No fix
   is needed if callers pin their own array as described above. Just don't rely on
   `manifest.get` returning the same bytes later in a session.
