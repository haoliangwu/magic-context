# User text appended inside an already-served provider user message

Investigation: 2026-10-07 UTC. **Report only; no runtime change.** Worktree base
`d29d4a926d62626724d3dacaaf533698ed649df2`. Host: OpenCode **1.18.30**
(`~/.opencode/bin/opencode`). This follows section 2 of
[rust-tag-late-first-serve.md](rust-tag-late-first-serve.md), which separated two
small cache busts (AFT 20:50:25.970, ALF 21:06:21.843 on October 6) from the
last-known-good retag bug.

## Result first

**The cause is in OpenCode, not in Magic Context or Prefrontal.** Owner: OpenCode,
`packages/opencode/src/session/prompt.ts` (`SessionPrompt.createUserMessage` and
`SessionPrompt.run`).

1. OpenCode stamps a user message's `time.created` at the **start** of
   `createUserMessage`, before part resolution and the `chat.message` plugin hooks,
   and writes the row only **after** them (local OpenCode checkout
   `prompt.ts:660` stamps, `:999-1011` runs hooks, `:1046-1047` persists; the
   1.18.30 binary has the same order in its minified `SessionPrompt.createUserMessage`).
2. Each loop step loads its history snapshot **first**
   (`prompt.ts:1092`, `MessageV2.filterCompactedEffect`) and only later creates the
   step's assistant with `time.created: Date.now()` (`prompt.ts:1186-1201`). The
   snapshot is the array passed to `experimental.chat.messages.transform` and to
   provider conversion (`:1255`, `:1262`).
3. History is ordered by `(time_created, id)` (`message-v2.ts:439`; 1.18.30's
   `MessageV2.page` orders `desc(time_created), desc(id)`), and 1.18.30's
   `MessageV2.latest` picks the step's parent by the same key.

So a user message that is **stamped before** the step's assistant is created but
**written after** that step's snapshot was read is missing from that step's
request, yet sorts **before** that step's assistant in every later load. On the
next step it is inserted directly after the user/tool-result message the previous
request ended with. Provider conversion then has to merge them:
`@ai-sdk/anthropic` `groupIntoBlocks` puts consecutive `user` and `tool` model
messages into one Anthropic `user` message (bundled in the 1.18.30 binary; source
`@ai-sdk/anthropic` 3.0.x `dist/index.mjs:2999-3036`). The served carrier gains a
new trailing block. That conversion is correct for Anthropic's role alternation;
the defect is the late insertion position.

Magic Context only forwards what it receives: it saw the shorter history on the
first step, the longer one on the next, and kept OpenCode's order in both TS and
Rust mode. Prefrontal's wakes are ordinary `session.promptAsync` user messages;
they are frequent busy-time arrivals, so they hit the window most often, but the
same race hits human messages (three of 17 incidents).

**Frequency:** 17 incidents in the last 24 hours on the live store (16 with a
metered next request), in 4 long-lived sessions. **Cost:** small. In 14 of 16 metered
cases Anthropic still read the whole previous prefix; only the two windows from
the earlier report lost the previous request's write: **1,573 + 434 = 2,007
tokens** re-written instead of read, over the day.

**Smallest fix (OpenCode, two edits):** stamp a user message when it is written,
and give each step's assistant a position taken before its snapshot, dropping
from that step's request anything that sorts after it. Details and proving tests
are in [the fix section](#smallest-fix-that-keeps-served-bytes-unchanged).

## Evidence

### Analyzer first

The requested first command was run first, for the AFT window. The October 6
dumps for 20:50 and 21:06 no longer exist (the ALF window precedes retention
too, so its run would select nothing either): the dump directory's retention now
starts at **2026-10-06T21:44:44.547Z** (3,651 bodies at 09:43 UTC October 7),
so `analyze-cache-busts.ts --session ses_313660571ffeZTsf4koSJwk50Q --since
2026-10-06T20:50:00Z --until 2026-10-06T20:50:35Z --show-diff --all-rows`
reports `No dumps found`. The byte diffs for those two windows are the earlier
report's preserved evidence (first divergence at the carrier, previous blocks
unchanged, one new block). This report adds the stored-message and log evidence
that explains them, and a retained incident with bytes:

```text
bun packages/plugin/scripts/analyze-cache-busts.ts --session ses_12a4fa38dffe81Fz7Y2AsWb5Cg \
  --since 2026-10-07T09:49:30Z --until 2026-10-07T09:50:00Z --show-diff --all-rows
10-07 09:49:56 UTC | 1380 | STABLE (meter) | read=635,213 + input=2 = 635,215; floor=635,153
  (prevTotal=635,217) | BYTES-ONLY | message[1377] role=user parts=[text(962),text(1259)] (bytes BUST)
  prev: …</system-reminder>"}[]]}
  cur:  …</system-reminder>"}[,{"type":"text","text":"§102970§ <system-reminder>\nBackground task `bg_7850ee908323dfc2` …
```

Same shape, raw bodies `…000706…` (09:49:41.652) and `…000712…` (09:49:56.272):
`messages[1376]` was the final served message
`[text §102969§ <system-reminder> Wake digest …]` (with `cache_control`); the next
request has the identical block (same normalized hash) plus
`text §102970§ <system-reminder> Background task …`.

### AFT, October 6 20:50 (`ses_313660571ffeZTsf4koSJwk50Q`)

Read-only `SELECT`s on `~/.local/share/opencode/opencode.db?mode=ro`, plus the
plugin log (`$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/magic-context.log.1`,
which covers 2026-10-06T20:16 to 2026-10-07T08:19):

| UTC | Row / log | Meaning |
| --- | --- | --- |
| 20:50:07.340–.346 | `msg_112fb0102…` step-finish, completed | Step ending in tool `toolu_014RTUE48LciFKYgZd1mRoie`. The loop starts the next step and loads history. |
| 20:50:07.632 / .634 | user `msg_112fb1690001CALSzzq3xnikC6` stamped / part written | "First we need to figure out broca issue." Stamped and written within 2 ms. |
| 20:50:07.676 | assistant `msg_112fb16bc…` created, **`parentID` = `msg_112fb00da…`** (the older user) | The step's snapshot did not contain the new user message. |
| 20:50:08.275 | P: `findSessionId … messages=7997` | Host input for that step: 7995 + the previous assistant + the earlier user `msg_112fb00da`; the 20:50:07.632 message is **absent**. |
| 20:50:09.885 | request 000005 (earlier report) | Ends with the tool-result carrier for `toolu_014RT…`. |
| 20:50:23.814 | assistant `msg_112fb55c6…`, `parentID` = `msg_112fb1690…` | Next step. |
| 20:50:24.418 | P: `messages=7999` | +2: the late user message **and** `msg_112fb16bc`, loaded in `(time_created,id)` order: user (…07.632) **before** assistant (…07.676). |
| 20:50:25.970 | request 000006 | `message[233]` = tool result `toolu_014RT…` + new text block `§37629§ First we need…`. |

The Magic Context passes for these steps were `SOFT+ served_from=transform` with
`in=7995 out=260` (20:50:03.224), `in=7997 out=262` (20:50:08.791) and
`in=7999 out=264` (20:50:24.942).

The same session had a second race five seconds earlier that the analyzer did not
count as a bust: user `msg_112fb00da…` ("Don't do any mason work right now.",
stamped 20:50:02.074) is absent from the 20:50:02.702 step (`messages=7995`), whose
assistant `msg_112fb0102…` was created at 20:50:02.114 with the older parent.

### ALF, October 6 21:05–21:06 (`ses_227ce5788ffeRPA9THoPLOQreO`)

| UTC | Row / log | Meaning |
| --- | --- | --- |
| 21:05:55.155 | user `msg_113098bd3…` | "AFT's session busted once again when I restart the TUI session " |
| 21:05:55.201 / .202 | user `msg_113098c00001YM5M7Boa9sPelG` stamped / part written | Prefrontal wake digest `<system-reminder>\nWake digest …`, a separate user message, 46 ms later. |
| 21:05:56.072 | assistant `msg_113098f68…`, `parentID` = `msg_113098bd3…` | Snapshot lacked the wake digest. |
| 21:05:57.476 | P: `findSessionId … messages=17136` | The previous pass had 17134; +1 assistant +1 user. Wake digest absent. |
| 21:06:03.678 | P: `rust pass: … SOFT+ … served_from=transform in=17136 out=572` | Healthy Rust pass on that input. |
| 21:06:12.729 | assistant `msg_11309d079…`, `parentID` = the wake digest | Next step. |
| 21:06:14.087 | P: `messages=17138` | +2: wake digest **and** `msg_113098f68`, wake digest sorted first. |
| 21:06:20.276 | P: `rust pass: … SOFT+ … in=17138 out=574` | Healthy Rust pass. |
| 21:06:21.843 | request 000060 (earlier report) | `message[463]` keeps `§41026§ AFT's session…` and gains `§41027§ <system-reminder>\nWake digest`. |

Both module passes around each event are ordinary `SOFT+ served_from=transform`
passes. The input counts are the host's array length at entry
(`findSessionId … messages=`), before Magic Context touches it, so **the missing
message was missing from OpenCode's input**, not dropped by Magic Context. If Magic
Context had dropped it, the first count would already include it.

### OpenCode source that decides it

From the local OpenCode checkout (`~/Work/Projects/opencode`, remote
`anomalyco/opencode`, package version 1.18.3); the 1.18.30 binary's bundled code
(`strings` of `~/.opencode/bin/opencode`) has the same structure:

- `prompt.ts:657-660` `const info = { id: input.messageID ?? MessageID.ascending(), …, time: { created: Date.now() } … }`;
  `:995-1011` resolves parts and triggers `chat.message`; `:1046-1047`
  `sessions.updateMessage(info)` then `updatePart`. The `message.time_created`
  column equals `data.time.created` (checked on the rows above).
- `prompt.ts:1092` `let msgs = yield* MessageV2.filterCompactedEffect(sessionID)` at the
  top of each loop iteration; `:1180` reminders; `:1186-1201` assistant
  `{ id: MessageID.ascending(), parentID: lastUser.id, … time: { created: Date.now() } }`
  and `updateMessage`; `:1255` `experimental.chat.messages.transform` with `msgs`;
  `:1262` `MessageV2.toModelMessagesEffect(msgs, model)`.
- `message-v2.ts:425-489` `page`/`stream`: 50-row pages, newest first,
  `orderBy(desc(time_created), desc(id))`. In 1.18.30, `MessageV2.latest` compares
  `time.created` and then `id` (`function Jt(e,t){…e.time.created>t.time.created…}`).

The race window per step is therefore *[snapshot read, assistant stamp]*, which
includes paging the **whole** history (larger sessions, longer window), widened
backwards by the user message's own stamp-to-write latency. Over all 3,514 live
user messages in the last 24 h, stamp-to-first-part latency was median 12 ms,
p75 145 ms, p90 1,144 ms, p95 2,548 ms. Magic Context's `chat.message` hook
(`packages/plugin/src/index.ts:951-974`, `hooks/magic-context/hook-handlers.ts:187-300`)
does map updates and at most one cache-TTL seed write; this investigation did not
attribute the long tail to any particular plugin or host step.

## Real-host reproduction

Probe added: [`packages/e2e-tests/src/repro/user-append-race-real-host.ts`](../../packages/e2e-tests/src/repro/user-append-race-real-host.ts).
It uses the existing e2e `TestHarness` (OpenCode `serve` on PATH, version
**1.18.30**, loopback mock Anthropic SSE provider) and a small wrapper plugin
around the built Magic Context plugin. Isolation is the harness's: private
`HOME`, `CFFIXED_USER_HOME`, `XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR`, all under
`$(getconf DARWIN_USER_TEMP_DIR)magic-context/user-append-race-probe/opencode-e2e-*`.
Each run's `lsof` of the host process is checked and saved; every open `.db`
file was inside that run's root, for example
`…/user-append-race-probe/opencode-e2e-v23Av9/data/opencode/opencode.db` (and
`-wal`, `-shm`). No live store or host was touched by the probe.

Scenario:

1. Prompt `RACE_START …`. The mock answers step 1 with `tool_use read` after 400 ms.
2. When the mock **receives** step 1, the probe posts `LATE_USER …` with
   `prompt_async`. OpenCode stamps it immediately. The wrapper plugin holds this
   one message's `chat.message` hook for `--delay` ms, reproducing the
   production stamp-to-write latency on demand; nothing else is altered.
3. Step 2 runs while the late message is still unwritten; the mock answers it
   with another `tool_use read`, slowly enough for the late message to land.
4. Step 3 includes the late message. The probe compares the final message of
   request 2 with the same index in request 3, ignoring `cache_control`.

Results (`result-<mode>-<delay>.json` and traces in the probe root):

| Mode | `--delay` | Request 2 final message | Same index in request 3 | Served bytes |
| --- | ---: | --- | --- | --- |
| none (no Magic Context) | 2500 | `[tool_result toolu_race_1]` | `[tool_result toolu_race_1, text "LATE_USER …"]` | **rewritten** |
| TS | 2500 | `[tool_result toolu_race_1]` | `[tool_result toolu_race_1, text "§3§ LATE_USER …"]` | **rewritten** |
| Rust | 2500 | `[tool_result toolu_race_1]` | `[tool_result toolu_race_1, text "§3§ LATE_USER …"]` | **rewritten** |
| none | 0 (control) | `[tool_result toolu_race_1, text "LATE_USER …"]` | unchanged | unchanged |
| TS | 0 (control) | `[tool_result toolu_race_1, text "§3§ LATE_USER …"]` | unchanged | unchanged |

In every raced run the stored order matches production: the late user row is
stamped before step 2's assistant and that assistant's `parentID` is the first
user. In the no-plugin run: user stamped `…393938`, step-2 assistant created
`…396062` with parent `RACE_START`, user written `…397037` (3,099 ms after its
stamp under this machine's load), step-2 transform input = `[RACE_START, A1]`.
The Magic Context TS and Rust runs' transform traces show output order equal to
input order on every step. The Rust run used the hermetic ck-subc + ck-mc stack
(built from this worktree) and logged three `rust pass` lines, `HARD
first_render in=1 out=3`, `SOFT+ in=2 out=4`, `SOFT+ in=4 out=6`, all
`served_from=transform`: step 2's input was `[RACE_START, A1]` although the late
message had been stamped 1,381 ms before step 2's assistant was created; step 3's
input was `[RACE_START, A1, LATE_USER, A2]` and its output kept that order. In the controls the late message is written at once, lands
in step 2's snapshot, and merges with the *new* tool-result carrier instead.

So OpenCode plus `@ai-sdk/anthropic` alone reproduces the rewrite; Magic Context
neither causes nor prevents it.

## How often

Read-only scan of the live store, window 2026-10-06T10:08:12Z to
2026-10-07T10:08:12Z (358 sessions updated, 3,513 user messages, 15,847 assistant
steps). An incident is a user message `U` whose next assistant `A` (in
`(time_created, id)` order) has a `parentID` that sorts before `U`: `A`'s step
did not have `U`. That rule is OpenCode's own parent choice, so it does not
depend on dumps.

| UTC (Oct 6 unless noted) | Session | Late message | Merged into | Stamp→write ms | Lost tokens |
| --- | --- | --- | --- | ---: | ---: |
| 12:04:27.610 | ALF | Wake digest | tool result | 127 | 0 |
| 13:14:05.806 | ALF | Wake digest | tool result | 985 | 0 |
| 13:35:17.291 | `ses_12a4…` | channel notice | user | 467 | 0 |
| 14:57:38.050 | `ses_12a4…` | background bash completed | user | 485 | 0 |
| 15:26:01.714 | `ses_0758…` | channel notice | user | 886 | 0 |
| 16:21:41.343 | ALF | parked-question answer | user | 1,722 | 0 |
| 16:21:43.762 | ALF | parked-question answer (same step) | user | 803 | 0 |
| 16:43:38.182 | AFT | Wake digest | tool result | 788 | 0 |
| 18:33:21.849 | ALF | Wake digest | user | 2,487 | n/a (that step errored) |
| 18:43:48.537 | ALF | unanswered-question reminder | user | 187 | 0 |
| 19:53:38.213 | ALF | Wake digest | user | 108 | 0 |
| 20:23:51.760 | ALF | Wake digest | tool result | 2 | 0 |
| 20:30:05.339 | ALF | human text | tool result | 2 | 0 |
| 20:50:02.074 | AFT | human text | tool result | 2 | 0 |
| 20:50:07.632 | AFT | human text | tool result | 2 | **1,573** |
| 21:05:55.201 | ALF | Wake digest | user | 1 | **434** |
| Oct 7 09:49:37.310 | `ses_12a4…` | background-task notice | user | 22 | 0 |

- **17 incidents / 24 h**, 0.48 % of user messages, all in four long-running main
  sessions (ALF 10, AFT 3, `ses_12a4…` 3, `ses_0758…` 1). 12 are Prefrontal
  notices (7 wake digests, 3 ask answers or reminders, 2 channel notices),
  2 background-task completion notices, 3 human messages.
- "Lost tokens" = previous step's `input + cache.read + cache.write` minus the
  next step's `cache.read + input` from the stored assistant token counts.
  14 of 16 metered incidents lost nothing (within ±4 tokens): Anthropic still
  matched the previous breakpoint, which sits at the end of the old final block.
  The analyzer marks such pairs `BYTES-ONLY` (bytes changed, meter stable).
- Retained dumps from 21:44 onward contain two appends into a served final user
  message across 3,627 consecutive same-session pairs; both read the full prior
  prefix (`09:49:56` above and `ses_efe8a2cabffe…` at 22:50:00, the latter a
  `tool_result` carrier).

## Cost

Total metered loss in 24 h: **2,007 tokens** that were written again instead of
read (AFT 1,573, ALF 434). This matches the earlier report's "shortfall of prior
total" (1,573 and 434). The analyzer's larger "rewritten" figures (2,843 and
1,806) are the whole cache write of those requests, including the genuinely new
tail. At Anthropic's write premium this is a few thousand input-token
equivalents per day: negligible next to one HARD bust.

Why only two of 16 merges missed is **not established**. Both missed back to
exactly the previous request's own write. ALF's old final block was the only
user-text carrier ending in whitespace (`…restart the TUI session `; the other
nine end in `</system-reminder>`, stored text), and the 19 retained pairs whose
final user text ends in whitespace but gained nothing appended all hit. AFT's
old final block was a `tool_result` whose stored output ends in a newline, as
do four tool-result merges that hit. Both bodies
have expired, and testing tokenization against the real provider was outside
this report's scope. The deterministic fact is the byte rewrite; the price
depends on the provider.

Secondary effect, not priced: the late message is shown to the model as if it
preceded an action the model took without having seen it (for example, "Don't
do any mason work right now." placed before a tool call made without it).

## Smallest fix that keeps served bytes unchanged

The invariant to restore: **every message that sorts before a step's assistant
was in that step's request, and every message that was not sorts after it.**
Then a late arrival always lands after the served tail, in a new provider
message, and the served bytes never change.

### Owner: OpenCode (recommended)

Two edits in `packages/opencode/src/session/prompt.ts`:

1. `createUserMessage`: set `info.time.created = Date.now()` immediately before
   `sessions.updateMessage(info)` (after part resolution and `chat.message`), not
   at line 660. A message then cannot be written later than its own sort key.
2. `run` loop: take the step's position **before** reading history, then drop
   from this step's request anything that sorts after it:

   ```ts
   const stepTime = Date.now()
   const stepID = MessageID.ascending()
   let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
   // ... unchanged exit / compaction / agent checks on the full snapshot ...
   const requestMsgs = msgs.filter((m) =>
     m.info.time.created < stepTime || (m.info.time.created === stepTime && m.info.id < stepID))
   const msg = { id: stepID, time: { created: stepTime }, ... }
   ```

   `requestMsgs` replaces `msgs` for reminders, tools, the transform hook and
   `toModelMessages`. A late message is in the next iteration's snapshot, sorts
   after this assistant, and the loop's exit check (`parentID === lastUser.id`)
   still sees it, so nothing is lost.

Edit 1 alone is not enough: the AFT 20:50:07 incident had a 2 ms stamp-to-write
gap and still raced, because the snapshot read precedes the assistant stamp by
the whole history load (about 330 ms on that 8,000-message session). Edit 2 alone
is not enough when a hook delays the write (production p90 1.1 s).

Tests that would prove it (OpenCode side):

- A plugin `chat.message` hook that holds one user message while a tool step
  runs: the next request's model messages must contain the previous request's
  final message unchanged, with the late text in a later message after the
  step's assistant. Today this fails; it is exactly the probe above.
- `createUserMessage` with a slow `chat.message` hook: stored `time.created` is
  not earlier than the hook's completion.
- Loop: a user message written between the snapshot and the assistant stamp is
  excluded from that step's request and included, after that assistant, in the
  next step; the loop does not exit without answering it.

Acceptance from this repository, unchanged probe:
`user-append-race-real-host.ts --mode none|ts|rust --delay 2500` must report
`servedTailUnchanged: true` for pair `2->3`, with `LATE_USER` appended to request
3's final `tool_result toolu_race_2` message; `--delay 0` stays unchanged.

### Magic Context mitigation, if OpenCode does not change

Magic Context owns provider-cache stability, and the misplacement is detectable
from data OpenCode stores durably: an assistant whose `parentID` sorts before
the user messages immediately preceding it did not see them. A deterministic
reorder at the outer message-transform boundary
(`packages/plugin/src/plugin/messages-transform.ts`, before tagging, LKG and the
TS/Rust split) could move that run of user messages to just after the
assistant. That matches what the model actually saw, gives the same order on
every later pass and after restarts, and needs no state.

It is not free: it changes the host's message order inside Magic Context, so it
needs (a) unit tests for the rule (single and multiple late messages, tool-result
and user carriers, errored and text-only assistants, no-op when `parentID` is
the preceding user, compaction-reordered arrays untouched), (b) a two-pass
idempotence test that the second pass's output equals the first's plus the new
tail, (c) Rust adapter tests that the module, native cache and LKG see the
relocated order consistently, and (d) the real-host probe above passing in TS
and Rust mode. Prefer the OpenCode fix; take this only if upstream declines.

### Not the fix

- Tagging changes: the existing blocks keep their bytes; tags on the new block
  are minted on first serve.
- Prefrontal delivery changes: wakes use OpenCode's documented busy-time
  `promptAsync`; human messages race the same way.
- Splitting the merged message for Anthropic: role alternation requires the
  merge, so the only byte-stable place for the late text is after the served tail.

## Verification and limits

- Live data: SQLite opened read-only with `?mode=ro` URIs (Python 3.9.6); no
  copy or write. Logs and dumps read in place.
- The four October 6 dumps for these windows had already expired; their byte
  diffs come from the earlier report. The retained 09:49:56 incident confirms
  the byte shape directly.
- Real-host probe: OpenCode 1.18.30, Bun 1.4.2. Raced none/TS/Rust runs and
  none/TS controls as tabulated, each with `lsof` proof; the Rust run included
  building ck-mc and ck-subc into `packages/e2e-tests/.cache` (24 minutes under
  load). Run artifacts stay in the probe root, outside git.
- `tsc --noEmit -p packages/e2e-tests/tsconfig.json` (TypeScript 5.9.3): no
  error in the new probe; 21 existing errors in 13 other files.
- The scan's incident rule relies on OpenCode's `parentID`; an assistant created
  by a compaction or subtask path would need separate handling. None appeared in
  the 17.
