# Issue 602: compaction origin investigation

Read the issue and all seven comments before testing. **The reported combination
did not reproduce:** published Magic Context 0.44.4 on OpenCode 2.0.21, automatic
compaction off, and a 1M-token mock model completed the dreamer mapping. No
compaction row existed. Therefore this investigation does **not** identify a
manual caller on the reporter's host. The earlier assertion that OpenCode itself
starts these compactions with that configuration remains unsupported.

## Real-host experiment

Installed `@opencode/cli@2.0.21` and `@opencode/cli@2.0.22` in throwaway directories;
the binaries reported those exact versions. Obtained the published plugin using
`npm pack @cortexkit/opencode-magic-context@0.44.4`, then unpacked it there
(tarball SHA-1 `7c5f9efec4748e80604a746ef6dd2e1851f2f69a`). The master comparison
uses this checkout at `55b70ea82b091b4ffb41cd901552b6b7fe5c1e14`, not another
published build, despite its unchanged package version string.

Each fresh `serve --service` host used the repository's OC2 runner, a loopback
Responses mock, one pending project memory, and the native command endpoint:
`POST /api/session/:id/command`, `{"name":"ctx-dream","text":"map-memories"}`.
The native config selected `openai/mock-model`, explicitly set
`compaction.auto=false`, and advertised `limit.context=1000000` and
`limit.output=32768`. The global `AGENTS.md` contained **27,000 UTF-8 bytes of
CJK instructions**. There were **45 configured skills**, totalling **19,800 bytes
of names and descriptions**. The first hidden draft actually contained the global
instructions (~28.2 KB total system), but **not the skill frontmatter**: the
carrier denies skills. See release `packages/plugin/src/v2/hooks/hidden-child.ts:53–77`
and OpenCode `packages/core/src/skill/instructions.ts:73–89`, which filters by
permissions. Do not assume all ordinary-agent injection reaches a hidden carrier.

A passive wrapper imported the unmodified plugin bundle, recording session API
calls and compaction/context drafts before and after its callbacks. SQLite audit
triggers on the **throwaway** host's `session_message` copied every insert, update,
and pre-delete row into `probe_messages`. Thus deletion was not held or disabled,
and the evidence survives both successful and failed child removal. Every inserted
child message had a corresponding pre-delete capture. Both bundles' SHA-256 values
are in the capture manifests.

| Arm | Host / plugin | Auto | Window | Compaction | Provider requests | Mapping |
|---|---|---|---:|---|---:|---|
| A | 2.0.21 / published 0.44.4 | false | 1,000,000 | none | 1 | processed 1 |
| B | 2.0.22 / master | false | 1,000,000 | none | 1 | processed 1 |
| C, config control | 2.0.21 / published 0.44.4 | false | 1,300 | none | 1 | processed 1 |
| D, deliberately forced auto control | 2.0.21 / published 0.44.4 | true | 1,300 | **auto** | 0 | refused, processed 0 |
| E, same forced auto control | 2.0.22 / master | true | 1,300 | **auto** | 1 | processed 1 |

C versus D demonstrates that `auto=false` really reached the child's compaction
policy; the small window deliberately crosses the threshold, and the mock does
not enforce that window. D demonstrates that the capture can observe the precise
failure despite immediate deletion. Its task took **58 ms**, so timing alone does
not distinguish automatic from manual compaction. **D is not a reproduction of
the reporter's disabled-auto/1M configuration.**

## Captured child rows

These are **every distinct `session_message` row's final state before deletion**.
Sequence gaps are host event sequences, not missing message rows. All assistant
rows used `openai/mock-model`, agent `dreamer-memory-mapper`, returned
`<mappings><memory id="1" files="src-fixture.ts"/></mappings>`, and recorded
120 input / 20 output tokens. The audit files also retain streaming updates.

| Arm / child session | seq | type | reason | payload / outcome |
|---|---:|---|---|---|
| A: `ses_efea0eebdffeNYpeh5BX0QD2Hf` | 4 | user | null | registered `mc:hidden:` marker |
| A | 5 | assistant | null | mapping, finish=stop |
| A | 10 | idle | null | succeeded |
| B: `ses_efea0dde9ffe7haPuz9QhSwNJt` | 4 | user | null | registered marker |
| B | 5 | assistant | null | mapping, finish=stop |
| B | 10 | idle | null | succeeded |
| C: `ses_efea0cd9dffeLKLXf07NF7C46l` | 4 | user | null | registered marker |
| C | 5 | assistant | null | mapping, finish=stop |
| C | 10 | idle | null | succeeded |
| D: `ses_efea0bdf4ffeOBK2MVP7jMJaGb` | 4 | user | null | registered marker |
| D | 5 | compaction | **auto** | running → completed; ordinary history/memory summary |
| D | 7 | idle | null | failed; `hidden_prompt_unrecognized` in hook/log |
| E: `ses_efea0af33ffePrMyKV3smjPM8M` | 4 | user | null | registered marker |
| E | 5 | compaction | **auto** | running → completed; summary=registered marker |
| E | 7 | assistant | null | mapping, finish=stop |
| E | 12 | idle | null | succeeded |

D's compaction `msg_1015f422e001983ZcL5Cqt8kpK` was inserted with:

```json
{"time":{"created":1791024382510},"status":"running","reason":"auto","summary":"","recent":""}
```

It completed with `recent=""` and this exact summary, not the registered marker:

```xml
<session-history></session-history>

<project-memory>
<ARCHITECTURE>
#1: The fixture flag lives in src-fixture.ts
</ARCHITECTURE>
</project-memory>
```

No arm recorded `reason="manual"` or a plugin `session.compact` call.

## Who starts the observed compaction?

Line references below are from the downloaded **v2.0.21** OpenCode source and
**v0.44.4** Magic Context source, cross-checked against the published bundle.

1. **OpenCode starts D**, in
   `packages/core/src/session/runner/llm.ts:215–221`: `runStep` calls
   `compaction.compact({reason:"auto", context:loaded})` before the primary hook.
   `packages/core/src/session/compaction.ts:199–206` rejects every non-manual
   trigger when automatic compaction is off, then tests the auto size ceiling.
2. OpenCode's `compaction.ts:263–270,563–579` prepares the compaction request and
   dispatches its hook. **Magic Context answers; it does not initiate it**:
   `packages/plugin/src/v2/hooks/context.ts:1014–1063` calls `FoldOwner.supply`
   and assigns `draft.result={summary:fold.submitted}`. `fold/owner.ts:41–64`
   only materializes/persists the supplied fold; it admits no compaction.
   Published equivalents: `dist/v2/server.js:155218–155232,128124`.
3. OpenCode `compaction.ts:377–381` publishes the automatic start and consumes
   the hook result without calling the provider. Its
   `session/runner/to-llm-message.ts:303–321` wraps that summary as a user
   `<conversation-checkpoint>`. Magic Context's
   `hooks/hidden-child.ts:212–231` cannot match that wrapper to the registered
   marker and refuses it (`dist/v2/server.js:79140–79149`).

The released child path creates an **unparented** session
(`hidden-completion.ts:896–908`) and sends a marker with `host.prompt`
(`:1221`); it does not request compaction. OpenCode 2.0.21's plugin API
(`packages/core/src/plugin/host.ts:527–561`) exposes neither `compact` nor
`remove`. No explicit compaction admission was found in the released adapter.

For a **manual** row, the source path would instead be:
`POST /api/session/:id/compact` → OpenCode
`packages/server/src/handlers/session.ts:430–434` →
`packages/core/src/session/session.ts:247–264` →
`session/inbox.ts:204–225` (`admitCompaction`) →
`session/runner/llm.ts:88–92,112–150`, which delivers the control and explicitly
uses `reason="manual"`. This is a conditional trace, **not an observed caller**.
The reporter's row, effective config/model, and admission caller still need capture;
even a manual row alone would not identify which client sent that request.

## Current master and smallest correction

Master on 2.0.22 was **not affected in B** and survived the intentionally triggered
compaction in E. Its children really retained their parents: B's parent was
`ses_efea0e372ffe3B7yIEr5PW8LJN`; E's was `ses_efea0b357ffehsvvP0juHrPGvO`.
The native path is `packages/plugin/src/v2/hidden-child-native.ts:120–135`;
OpenCode 2.0.22 `packages/core/src/plugin/host.ts:529–552` forwards `parentID`
and exposes `remove`/`compact`.

The smallest correction for the **confirmed Magic Context summary/recognition
defect**, not an unproven compaction initiator, is already on master:
`packages/plugin/src/v2/hooks/context.ts:1137–1153` answers an owned hidden child's
compaction with its single registered in-flight marker, and
`hooks/hidden-child.ts:242–246,319–335` recognizes that exact checkpoint. Keep
the guard closed to unregistered prompts; do not accept arbitrary first messages
by session ID. No code was changed here. Smart-note compilation was not separately
triggered, and the reporter's full plugin/TUI stack or converted store was not
recreated. Those limits prevent claiming the original report is resolved.

## Evidence, isolation, verification

Artifacts remain under
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-602-manual/`:
`probe.ts`, `validate.ts`, `validated-summary.json`, and these capture directories:

```text
published-off-1m-1791024368139       # A, host PID 78246
master-off-1m-1791024372466          # B, host PID 78513
published-off-tiny-1791024376733     # C, host PID 78811
published-auto-tiny-1791024380945    # D, host PID 79225
master-auto-tiny-1791024384910       # E, host PID 79537
```

Each contains `rows.json` (full data, including updates/deletes),
`plugin-trace.jsonl`, `dream-runs.json`, `provider-requests.json`, config,
manifest, logs, and `lsof-before.txt`/`lsof-after.txt`. All HOME/XDG roots,
`OPENCODE_DB`'s resolved path, `MAGIC_CONTEXT_STORAGE_DIR`, and project directories
were inside their throwaway root. The OC2 runner's `inspectOpenFiles` checked
the host process group, including writable descriptors. `lsof -p <host-pid>`
showed only these database families:

```text
$ARM/XDG_DATA_HOME/opencode/opencode2.db{,-wal,-shm}
$ARM/XDG_DATA_HOME/cortexkit/magic-context/context.db{,-wal,-shm}
```

No live store or live configuration was opened, read, copied, or migrated. All
shell commands and probe runs were bounded with `timeout`; hosts were stopped
through the runner. Final capture validation on **Bun 1.4.2 passed 56 checks over
five real-host arms**, covering rows surviving deletion, reasons, actual provider
traffic/backlog progress, global instruction bytes, native parents, and database
containment. Typecheck/build/lint were not rerun: the only repository change is
this report, using the worktree's already-built master bundle.
