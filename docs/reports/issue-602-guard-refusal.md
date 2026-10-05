# Issue 602: what the hidden-child guard actually recognizes

## Findings

Read issue 602 in full, including reporter comment **9** and the subsequent
maintainer acknowledgement (comment 10), and
[`issue-602-manual-compaction.md`](issue-602-manual-compaction.md).

**The reporter's configuration still does not naturally reproduce the refusal.**
Published 0.44.4 on a real OpenCode 2.0.21 service, with CJK instructions, 45
skills, a functioning four-tool MCP server with instructions, `compaction.auto=false`,
and `deepseek/deepseek-flash` advertised at 1,000,000 tokens, makes a model
request and processes its memory. Current master on 2.0.22 does too.

**The guard does not compare the persisted first message.** It compares the
**first nonempty eligible text part of the last drafted message** against a
registered marker. Adding a text part *before* the marker, a separate tag-only
part, or a virtual user message *after* the marker reproduces the reporter's
two-row failure on both builds: bare persisted marker at seq 4, failed idle at
seq 5, no compaction, no provider request. These are deliberately injected
controls, **not evidence that the reporter's instructions, skills, MCP server,
or another plugin actually performs such an injection**. Their exact delivered
texts are captured below. The reporter's actual drafted request is still needed
to distinguish these possibilities from an attempt-registration/lifecycle problem.

The earlier forced-auto-compaction reproduction is a separate, real defect,
already handled on master; it does not establish compaction as the cause of
comment 9. Nor do the sequence gaps establish an invisible compaction: this
investigation captured the ordinary events occupying seq 0–3.

Side observations:

* **Retrospective has a real OpenCode 2 wiring defect, still on master:** neither
  manual nor scheduled execution supplies its raw-history provider. It reports
  completion without inspecting the backlog or contacting a model.
* **Compress-cues is an intentional no-op when mural is disabled**, with
  misleading success accounting. With mural enabled, the controlled refusals
  produce a **failed**, not successful, run. Zero output/usage alone is not
  evidence of a swallowed refusal.
* **MC-D02 is a real misclassification, still on master:** a local preparation
  refusal gets classified as a provider error and rendered as connection advice.

No production code was changed.

## Published 0.44.4: every recognition/refusal condition

Obtained the actual release with
`timeout 120 npm pack @cortexkit/opencode-magic-context@0.44.4 --pack-destination "$R"`.
Tarball SHA-1: `7c5f9efec4748e80604a746ef6dd2e1851f2f69a`.
The authoritative references below are to its **`package/dist/v2/server.js`**,
not a rebuild of a release tag. The source names are the bundle's own section
labels. Master references are relative to this checkout at
`a23972bbba7c29162ae8f9e7f987aefd8627a393`.

### Extraction and lookup

Released `src/v2/hooks/hidden-child.ts` → bundle **79082–79100, 79140–79149**:

1. An unowned `draft.sessionID` returns `false`; this hook does not refuse it.
2. Read **`draft.messages.at(-1)`**, not the first message, and not a reverse
   search for the newest user. An empty draft, or a last message with a defined
   role other than `user`, produces `raw=undefined`.
3. A nonempty string `message.content` is the entire raw text. Otherwise use
   array `content`, or array `parts` if content is not an array. An empty content
   array does not fall back to `parts`.
4. Return the **first** object part with nonempty string `text` and type absent,
   `text`, or `input_text`. Skip empty, nonobject, and nontext parts. Do not
   concatenate parts or look past the first qualifying part for a marker.
5. Look up `attempts.get(raw)`, then, if different/nonempty, look up the text
   after `stripWellFormedLeadingTagPrefix(raw)`. This release already contains
   the inline ordinal-prefix fix: bundle **19275–19276** strips only
   `/^(§\d+§\s*)+/`. Repeated valid prefixes work; arbitrary leading whitespace,
   trailing whitespace, malformed tags, wrappers, and appended instruction text
   do not get normalized.
6. Read `current=active.get(draft.sessionID)` and select `attempt ?? current`.

There is **no `messages.length === 1` requirement**. Multiple messages work if
the last contains the marker at its first eligible text part. Extra parts *after*
that part do not invalidate it. Extra nontext/empty parts *before* it do not
invalidate it either. A nonempty instruction/skill/tag-only text part before it
does. A separate last user instruction, assistant, tool, or system message also
prevents initial recognition, even if an earlier user contains the exact marker.

The hook compares **no draft agent, model, variant, window size, parent ID,
metadata, directory, instruction length, or elapsed time**. Unit controls with
different draft agent/model still recognize the registered marker. Those fields
can influence host preparation, but are not predicates of this refusal.

### All sites throwing `hidden_prompt_unrecognized`

| Released bundle / source section | Refusing predicate | Master equivalent |
|---|---|---|
| **79148–79149**, `hooks/hidden-child.ts`, `apply` | No selected attempt; selected attempt belongs to a different child; or a matching attempt conflicts with a different active attempt on this child. This is the reporter's exact error sentence. | `packages/plugin/src/v2/hooks/hidden-child.ts:390–410` |
| **79154–79156**, `apply` | Selected attempt has not been shaped, but there is no matching marker attempt. An active-but-unshaped state is unusual under normal execution; this is a separate error sentence. | `hidden-child.ts:416–420` |
| **79110–79115**, `calibratedParts` | The **registered calibrated request**, not the incoming marker message, has absent/empty parts, a nonobject/nontext part, or nonstring text. Multiple valid text parts and empty string text are allowed here. | `hidden-child.ts:158–177,378–386` |
| **79171–79179**, later-step history search | Already-shaped run's draft history contains no user message whose first eligible text, after valid inline-prefix stripping, equals this run's marker. Active runs can otherwise continue with assistant/tool replies last. | `hidden-child.ts:438–457` |
| **129824–129825**, `src/v2/hidden-completion.ts`, `attempt` | A settled assistant row was collected without the context hook ever shaping this attempt. This is outside `HiddenChildHook.apply`, and says “Host did not dispatch the hidden child context hook.” | `packages/plugin/src/v2/hidden-completion.ts:641–648` |

Master additionally refuses an owned child's **compaction** if there is not
exactly one active/pending registered run: `hidden-child.ts:319–335,343–375`.
It recognizes an exact host checkpoint whose summary is the marker
(`:207–246`) and supplies that marker at
`packages/plugin/src/v2/hooks/context.ts:1137–1153`. Released 0.44.4 has neither
checkpoint recognition nor this hidden-specific compaction response.

Abort and step-budget exhaustion have different errors, not this code:
release **79151–79163**, master `hidden-child.ts:412–425`. There is no expiry
clock in the hook. Lifecycle can nevertheless matter: registration precedes
`host.prompt`, while `finally` releases the marker and its active binding
(release **129735–129743,129798–129802** and `releaseAttempt` at **79130–79135**;
master `hidden-completion.ts:520–528,729` and `hidden-child.ts:296–302`). A
late delivery after release would fail despite a correct persisted marker.
No such race was observed here.

Magic Context's managed context hook invokes the hidden guard **before its
ordinary tagging/transform** (release **155242–155245**; master
`hooks/context.ts:1208–1212`). Its ordinary v2 tagger therefore does not prepend
a new tag before this first-step guard in these runs. An inline `§123§ ` control
passes. A *separate* `{"type":"text","text":"§123§ "}` part before the marker
fails because extracting that part and stripping it yields an empty candidate.

## Real-host reproduction and registered-versus-delivered pair

Installed `@opencode/cli@2.0.21` and `@opencode/cli@2.0.22` under the task's
throwaway directory. Their version commands report `opencode v2.0.21` and
`opencode v2.0.22`. All hosts use the repository's `spawnOpencode2` isolation
runner, actual `serve --service` processes, native session creation and
`POST /api/session/:id/command` with `ctx-dream`. Only the remote model is
substituted: the real DeepSeek host adapter points to a loopback chat-completions
mock returning a valid mapping manifest. **This tests the host/guard path, not
DeepSeek's real credentials or service availability.**

The fully combined fixture has:

* 27,000 UTF-8 bytes of CJK global instructions, actually present in the hidden
  draft's **system**, not its user message;
* 45 skill directories, names/descriptions totalling 19,800 bytes;
* one local stdio MCP server advertising four tools and a few hundred bytes of
  instructions; captured `initialize` and `tools/list` prove it was connected;
* `compaction.auto=false`, selected model `deepseek/deepseek-flash`, configured
  context limit 1,000,000 and output limit 32,768;
* an active project memory and a source-file fixture, with manual mapping forced.

Ordinary user-session drafts in both builds contain **all 45 skill names and
the MCP instructions**. Hidden drafts contain neither: the carrier's permissions
deny skill/MCP access (release **79058–79077**, master `hidden-child.ts:53–77`).
OpenCode 2.0.21 filters skill guidance at
`packages/core/src/skill/instructions.ts:73–89` and MCP guidance at
`packages/core/src/mcp/instructions.ts:84–105`. Global instructions enter the
system baseline (`session/model-request.ts:100–119`), not a marker prefix.

A wrapper imports the **unmodified** release/master bundle and records the
native `session.prompt` arguments, host draft, draft immediately before the
Magic Context callback, callback result/error, and (in final captures) host
events. Only explicitly named injection arms modify that draft. SQLite triggers
audit every message insert/update/pre-delete and the pre-delete child-session
metadata, without preventing cleanup. Registered text is the marker passed to
`host.prompt`, which source inspection confirms was registered immediately
before that call; delivered text is recorded **before**, not after, shaping.

| Arm | 2.0.21 / 0.44.4 | 2.0.22 / master |
|---|---|---|
| Minimal configuration, auto off, DeepSeek 1M | 1 request, mapped 1 | not separately run |
| Add CJK global instructions | 1 request, mapped 1 | not separately run |
| Add 45 skills | 1 request, mapped 1 | not separately run |
| Add connected MCP server: complete reporter-size configuration | 1 request, mapped 1 | 1 request, mapped 1 |
| Full fixture + inline `§123§ ` prefix | 1 request, mapped 1 | unit control passes |
| Full fixture + instruction text part **after** marker | 1 request, mapped 1 | unit control passes |
| Full fixture + instruction text part **before** marker | refused, 0 requests, 0 mapped | same refusal |
| Full fixture + separate tag-only text part before marker | refused, 0 requests, 0 mapped | same refusal |
| Full fixture + virtual user instruction **after** marker message | refused, 0 requests, 0 mapped | same refusal |

**No arm in this investigation has a compaction row.** The pre-first-step
instruction-part refusal on 2.0.21 took 10 ms from persisted user to idle,
and master took 10 ms. The otherwise-identical Curate controls took 9 ms on
2.0.21 and 8 ms on 2.0.22. This reproduces the *shape* of comment 9 without
invoking compaction, while leaving its actual injection source undetermined.

### Concrete captured pair

Successful full-fixture child `ses_efe6bcd69ffe39V3rpW6I50ZBU`:

```text
registered = delivered = mc:hidden:e77dd0c8-e61a-4408-9e51-3aceb01951d9:1231ade2-0ef7-4128-808a-2b15034c6f66
length = 83
sha256 = bd68358e09a16eccc9f4470bc124911566ccc6218e1998a74b40e2d08a8a8a1c
draft.messages.length = 1; first/last user content = [text(marker)]
```

Controlled refusal child `ses_efe6af124ffeV1BNPp8oflziLy`:

```json
{
  "registered": "mc:hidden:d820f57a-905b-44d7-a1b1-3ebec911ca9b:5e0e3ed7-e2f9-4b84-8c9b-5c1917397f58",
  "guardRaw": "PROBE_INSTRUCTION: use the fixture safely.",
  "draft.messages.length": 1,
  "firstMessage": {
    "role": "user",
    "content": [
      {"type":"text","text":"PROBE_INSTRUCTION: use the fixture safely."},
      {"type":"text","text":"mc:hidden:d820f57a-905b-44d7-a1b1-3ebec911ca9b:5e0e3ed7-e2f9-4b84-8c9b-5c1917397f58"}
    ]
  }
}
```

Registered length/hash: **83** /
`129410e90ee6a1ca4239b36a10cdeea217492e2dd3159d47471559ffaa4c499c`.
Delivered raw length/hash: **42** /
`9f89407c907f04fd3022f216d39eaa53fb881c089131306c433d13f50e0521ae`.
The guard extracts the instruction, not the still-present marker.

Pre-delete `session_v2`: `parent_id=NULL`, agent `dreamer-memory-mapper`, model
`{"id":"deepseek-flash","providerID":"deepseek"}`, metadata
`{"magic_context":"hidden-run","role":"dreamer"}`. The only two message IDs
ever inserted are seq **4 user** (bare registered marker) and **5 idle**
(`outcome=failed`). Thus persisted equality does not imply drafted equality.
Master's corresponding control refuses despite its now-native parent linkage.

### Why seq 0–3 are missing from `session_message`

The final 2.0.21 event capture, child `ses_efe657319ffeZTDYVolldlHQKN`, records:

| seq | Actual host event | Message projection |
|---:|---|---|
| 0 | `session.created` | session row, not message |
| 1 | `session.inbox.enqueued` | inbox, not delivered message |
| 2 | `session.execution.started` | execution state, not message |
| 3 | `session.instructions.updated`, initial baseline | instruction state, not chronological message |
| 4 | `session.inbox.delivered` | user marker |
| 5 | `session.execution.failed` | idle failed |
| 6 | `session.deleted` | cleanup |

These are **event sequence numbers**, not four reserved virtual message rows.
OpenCode 2.0.21 `session/instruction-state.ts:44–59` explicitly keeps initial
instruction synchronization out of chronological history; `session/projector.ts:625–649,671–679`
projects delivered input, idle, and instruction state separately. Also,
`bus.ts:203` defaults event-payload persistence to **false**. An empty `event`
table is therefore not evidence of an unpersisted compaction. All observed
child input messages here were persisted. Comment 9 does not justify assuming
that these children have an invisible, in-memory-only compaction head.

## Side observation (a): zero-work “success”

Final side fixtures contain **110 active cue-less memories** and **five real
user sessions with messages**. Manual runs use disabled schedules to avoid
unrelated background tasks; forcing a named task still exercises its executor.

| Task / condition | 0.44.4 on 2.0.21 | Master on 2.0.22 |
|---|---|---|
| `compress-cues`, mural disabled | completed, 1 ms, 110 → 110, processed 0, no request | same, 1 ms |
| `retrospective` | completed, 0 ms, 5 → 5, spent 0, no request | completed, 1 ms, same counts |
| `compress-cues`, mural enabled + pre-marker refusal control | **failed**, 62 ms, 110 → 110, three refused chunks, no request | **failed**, 68 ms, same counts |

**Compression verdict:** not a functional failure when mural is off. Released
bundle **136888–136892** explicitly logs “skipped (mural is not enabled)” but
calls `recordRun("completed", null)`; master
`features/magic-context/dreamer/task-executor.ts:676–684` does the same. The
backlog predicate still counts missing cues regardless of this config, so an
unchanged 110 is expected. Calling that work “success” without a skip reason in
the persisted result is a presentation/accounting defect. Smallest correction:
carry a disabled/skipped reason into the run/detail and do not present it as
successful processing. Do not enable mural merely to make the count move.
With mural on, the incomplete check at release **136911–136914**, master
`:707–710`, correctly marks refusal-driven zero progress failed. The issue does
not establish that the reporter had mural enabled; if it was enabled, its
effective configuration and skip log are needed to explain a 0–1 ms completion.

**Retrospective verdict: real functional defect.** Released manual setup
**138268–138275** and scheduled setup **138317–138324** pass
`openOpenCodeDb:()=>null` and **no `retrospectiveRawProvider`**. Master
`v2/hooks/dream-manual.ts:85–92` and `dream-trigger.ts:55–62` retain that gap.
Provider resolution returns null (release **137191–137194**, master
`task-executor.ts:1071–1075`), the task returns a “clean no-op” with null
watermark (**137328–137335**, master `:1309–1313`), and the caller records success
(**137131–137154**, master `:986–1023`). It never reaches the hidden guard, so
this is **not the same refusal being swallowed**. The content watermark stays
unchanged while schedule completion advances.

Smallest functional fix: supply a bounded **OpenCode 2 `session_v2` /
`session_message` raw-history provider** implementing the shared retrospective
contract at both v2 executor construction sites. Until wired, report it
unavailable/skipped with an explicit reason, not successful. Do not attach the
OpenCode 1 raw provider unchanged: it reads legacy `message`/`part`, and a
converted store can retain stale versions of those tables.

`resultChars:0` is hardcoded for these specialized task records, not a measure
of model output (release **136825**, master `task-executor.ts:569`). Even the
successful mapping arm has `resultChars:0` and budget `spent:0`, despite its
captured provider response reporting **120 input / 20 output tokens**. Fast
completion can precede the hidden budget poll. This report uses actual HTTP
request captures, persisted assistant rows, and backlog writes—not those zero
telemetry fields—to decide whether a provider ran.

## Side observation (b): MC-D02 without a provider request

**Confirmed on both builds**, using Curate so the error reaches its task-level
failure detail rather than being replaced by a batch-incomplete message.
The controlled first-part refusal produces no assistant/provider request, but
`dream_runs.tasks_json` records `failure_class="provider_error"`, model attempted
`deepseek/deepseek-flash`, and its log reports **MC-D02**. The existing renderer
for that recorded class returns:

> Memory maintenance could not reach its model. Check the model connection,
> then run /ctx-dream again. (MC-D02)

The native command endpoint itself returns no response body; the renderer and
failure-detail path, rather than a TUI screenshot, were verified here.

The terminal collector wraps the host's `unknown` session error in a generic
`Error` (master `v2/hidden-completion.ts:256–267`). Prompt classification falls
through to `provider_error` for **any prompt/output-phase failure** (release
**79475–79496**, master `shared/model-suggestion-retry.ts:397–420`). Direct
`HiddenCompletionRefusal` also maps to provider error in the task fallback
(master `task-executor.ts:225–236`). User-facing mapping then chooses the
connection sentence (release **80236–80239,80273–80277**; master
`shared/user-facing-codes.ts:50–54,324–355`).
`features/magic-context/dreamer/storage-dream-runs.ts:44` uses that renderer for
the failure detail shown in the manual summary. The guard's own refusal is
terminal/local, not a provider authentication, network, or availability error.

Smallest correction: preserve a **typed local hidden-request refusal** through
host terminal collection and prompt/task classification, and map it to a
dedicated local-preparation failure sentence/code. Prefer retaining the hook's
typed refusal on its attempt over broad matching of arbitrary provider error
strings. Say the request was blocked before model dispatch and point to the
hidden-child diagnostic/update, not the model connection. Preserve genuinely
provider-originated errors as provider failures.

## What to fix in recognition, and what remains unknown

The full fixture did not require a recognition change. Master remains affected
by the **controlled first-part/last-message layouts**, while its compaction fix
only handles registered checkpoints. Do not claim that checkpoint fix resolves
comment 9 or weaken the guard to accept any first prompt by child-session ID.

For the reporter, collect the guard-entry message count, roles, ordered part
types, and per-text-part length/hash, plus registered marker digest and active/
pending state. Master's `hidden-child.ts:343–375` already logs message count,
newest role, raw/registered digests, active state, and differing bytes; it does
not log every part's digest. A whole-first-message capture in a user-controlled
diagnostic should be opt-in/redacted, since injected instructions may be private.
If a **trusted host-added text part** is confirmed, the smallest recognition
change is to select an exact registered marker from that authenticated input
layout, retaining child ownership and attempt-conflict checks and replacing the
input wholesale with the registered calibrated request. Do not search arbitrary
text for `mc:hidden:` substrings or accept arbitrary text on an owned session.
No injection producer or lifecycle race on the reporter's actual host was
identified, and smart-note compilation was not separately triggered here.

## Artifacts, isolation, and verification

Artifacts are under:

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-602-guard/
```

`probe.ts` reproduces the configurations and explicit controls; invocation is
`timeout 90 bun "$R/probe.ts" <published|master> <minimal|cjk|skills|full|side|side-enabled> <none|tag-inline|part-before|part-after|tag-part|virtual-tail> [task]`.
Default task is `map-memories`; the MC-D02 control passes `curate`.
Each arm has a manifest/PID, config, full draft/event trace, message/session
audits, provider requests, dream-run/schedule data, host/plugin logs, and
`lsof-before.txt`/`lsof-after.txt`. `validated-evidence.json` retains the full
registered/delivered pairs; `compact-evidence.json` summarizes them.

Key arms (directory basename / host PID):

```text
published-full-none-1791027850238                         / 8429
published-full-part-before-1791027906877                  / 9925
master-full-none-1791027918049                            / 10506
master-full-part-before-1791027920937                     / 10631
published-full-part-before-curate-1791028155501           / 39199
master-full-part-before-curate-1791028164576              / 39372
published-side-none-map-memories-1791028254897            / 42747
master-side-none-map-memories-1791028260741               / 42944
published-side-enabled-part-before-map-memories-1791028257815 / 42842
master-side-enabled-part-before-map-memories-1791028263814 / 42998
published-full-part-before-map-memories-1791028267100     / 43102
```

Bundle SHA-256:

```text
0.44.4: f431dc11bacae9fa92a825940c5fb440ba6d649c417e2290f5a7ab3e5425f8cf
master: 1739855e22280d77d264d000560455c82326518c33fd006e257de25485be8e02
```

Every host's HOME, XDG data/config/state/runtime/cache roots, native toolchain
roots, TMPDIR, and Magic Context storage directory are inside its arm.
The runner requires `OPENCODE_DB=opencode2.db`; its resolved path is
`$ARM/XDG_DATA_HOME/opencode/opencode2.db`, also inside that arm.
`lsof -p <host-pid> -Fin` and the runner's process-group `inspectOpenFiles` check
show only these application database families:

```text
$ARM/XDG_DATA_HOME/opencode/opencode2.db{,-wal,-shm}
$ARM/XDG_DATA_HOME/cortexkit/magic-context/context.db{,-wal,-shm}
```

No live store/config was opened, read, copied, written, or migrated. Only
throwaway stores were seeded/migrated. The runner's protected-path checks and
write fence passed at startup, after captures, and shutdown; hosts were stopped
through the runner. All command/probe invocations were bounded by `timeout`.

Verification on **Bun 1.4.2**:

* `timeout 45 bun test "$R/guard-matrix.test.ts"`: **54 tests, 74 assertions,
  0 failures**. Exercises the guard code extracted directly from the published
  bundle and the actual master hook, including prefixes, extra parts/messages,
  wrong-child/conflicting/released attempts, later steps, abort, calibrated-part
  rejection, and the release/master checkpoint difference.
* `timeout 60 bun test "$R/validate.test.ts"`: **118 tests, 760 assertions,
  0 failures across 24 completed real-host arms**. Validates actual lsof paths,
  deletion-surviving rows, registered/delivered pairs, instruction placement,
  MCP initialization, request counts, progress, side-task outcomes, and the
  MC-D02 class/renderer.
* Ordinary-draft inspection independently found 45 skill names and MCP guidance
  in both final side fixtures, while hidden drafts excluded both.

An initial side-fixture run failed because its seed used a nonexistent
`session_projects.created_at` column; this was fixed **only in the throwaway
probe**. Earlier successful side fixtures also seeded a duplicate `opencode`
binding alongside the host's `opencode2` binding, inflating retrospective
backlog to 10. The final four side arms use only the correct harness and verify
the requested **110 / 5** counts. Both the failed setup and earlier captures
remain in the artifact directory; neither is used to claim an exact-count
reporter reproduction. Typecheck/build/lint were not rerun: the sole repository
change is this report, and the worktree's prepared master build was used.
