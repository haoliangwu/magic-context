# Issue 602: maintenance wiring, skipped runs, and local refusals

This fixes the three side defects in
[`issue-602-guard-refusal.md`](issue-602-guard-refusal.md). It does not weaken
hidden-child recognition or claim to reproduce the reporter's unknown injection.
No database schema or migration was changed.

## Retrospective on OpenCode 2

Both manual and event-triggered execution now supply `V2RetrospectiveRawProvider`.
It uses the existing read-only `V2StoreReader`, native `session_v2` roots and
`session_message` user rows, and `opencode2` project bindings. It never reads
legacy `message`/`part`, even when a converted store retains stale copies.
Children, hidden-run roots, assistant content and tool output are excluded.

The shared scan retains its 20-session, 80-row/session and 240-row/run limits,
oldest-first admission, timestamp frontier and prompt-token budget. User text is
also capped before hydration; overlap reads are bounded and user-only. Metadata
queries use batches of at most 500 session IDs. Readers close after the scan.

The first real-host acceptance exposed an additional important assumption:
OpenCode 2's newly created sessions did not have `retrospective_activity` keys.
Depending on those keys selected no messages and falsely expired the backlog.
The provider therefore reads activity directly from native user timestamps.
The event trigger records those same source timestamps for the shared scheduling
gate, so a later user turn reopens the backlog without advancing it to an
assistant's completion time. The tests require an actual model request containing
every fixture user marker; backlog accounting alone cannot pass them.

Failing-first coverage:

* `retrospective unavailable runs are skipped, not successful` failed on master:
  the task appeared in `ran` and was counted successful without a provider.
* The new manual and scheduled real-host tests failed before the source-activity
  correction: zero friction requests, despite apparent completed records.
* The native reader test asserts literal oldest-first messages, exact saturation,
  bounded overlap/text, exclusion of stale/private rows, and independence from
  optional activity keys.

## Disabled/unavailable runs are skipped

`compress-cues` with mural disabled now records `status: "skipped"` and
`skipReason: "mural is not enabled"` inside `tasks_json`, with zero successes and
zero failures. The scheduler retains the content/success watermark, records the
skip reason, and advances to the next cron slot without hot retrying.
Manual summaries, `/ctx-status` text/dialogs, and dashboard run rows show the
skip and its reason rather than a completion/success badge. Enabled mural
processing is unchanged.

The same misleading-success patterns were corrected for:

* retrospective with no raw-history provider;
* any task with an unavailable Pi model chain;
* any task refused by single-store migration admission.

`compress-cues unavailable runs are skipped, not successful` and
`classify-memories unavailable runs are skipped, not successful` both failed on
master. The existing migration-refusal test deliberately changed its expectation
from completed/no record to skipped/recorded: that success claim was the accounting
defect, not successful work to preserve. Ordinary inspected empty queues and
per-item skipped verdicts remain valid completed runs.

## Local refusal is not a provider connection failure

`HiddenChildHook` retains its typed refusal on the affected child's attempt.
The hidden collector preserves it even when OpenCode serializes the terminal
session error as `unknown`. Classification uses that typed cause, not matching
arbitrary provider error strings. Terminal refusals do not retry another model.

Prompt and task failures now use `local_refusal`, `refusal_reason`, and **MC-D12**:
“Memory maintenance was refused before reaching the model.” The rendered detail
names the refusal reason and points to the hidden-request diagnostic, with no
connection advice. Actual provider failures retain **MC-D02**.

`direct hidden refusal has local failure detail and no connection advice` failed
on master with `provider_error`. Tests also cover prompt retry classification,
the host's wrapped `unknown` terminal error, and unchanged genuine provider-error
handling.

## Real-host acceptance and isolation

On **OpenCode 2.0.22**, the actual package union entry was rebuilt and run through
`spawnOpencode2` in service mode. Five sessions were created and prompted through
the native API, not seeded into a database. Each manual/scheduled retrospective
sent all five real user messages to the loopback provider's friction gate and
processed **5 → 0** pending sessions. A later user turn on the same root reopened
the gate and processed **1 → 0**. The mock returned `n`, a valid inspected window;
this proves history reading and backlog progression, not learning extraction or
external provider credentials/availability.

Passing capture roots (PID at capture):

```text
$TMPDIR/magic-context/issue-602-retrospective/mc-opencode2-qCX2jv / 38789 (manual)
$TMPDIR/magic-context/issue-602-retrospective/mc-opencode2-pyZ0RC / 38823 (scheduled)
```

Each root retains `proof.json`, `lsof-before.json`, `lsof-after.json`, the plugin
log and the throwaway stores/configuration. HOME, XDG data/config/state/runtime,
native-toolchain roots and Magic Context storage are isolated. `OPENCODE_DB`
resolves to the throwaway XDG data directory. The runner's real `lsof` inventory,
database-inode check, protected-path checks and shutdown write fence passed.
The only application database families opened were throwaway `opencode2.db` and
`context.db` (including WAL/SHM). No live store/config was opened, read, written,
copied or migrated.

The acceptance command was
`timeout 240 bun test --timeout 120000 packages/e2e-tests/tests/opencode2/retrospective.test.ts`:
**2 tests, 46 assertions, zero failures**, on Bun **1.4.2**. The file is registered
as OpenCode-2-only TypeScript coverage in the mode manifest; updated manifest
validation passed **7 tests, 46 assertions**. Earlier failed fixture captures are
retained but are not evidence of successful processing.

## Regression controls and verification

Four deliberate controls were run only after staging the live implementation.
Each had a nonempty working diff while applied and an empty working diff after
restoring the specific file from the index and touching it. No control remained
in the delivered source.

| Neutralized behavior | Exact test that went red | Other results |
|---|---|---|
| Manual raw-provider wiring | OpenCode 2 manual retrospective reads five real user sessions and drains their backlog | Scheduled host test passed |
| Scheduled raw-provider wiring | OpenCode 2 scheduled retrospective reads five real user sessions and drains their backlog | Manual host test passed |
| Disabled mural skip accounting, replaced with completion | compress-cues unavailable runs are skipped, not successful | Other four availability tests passed |
| Typed refusal retention on the hook attempt | host unknown terminal error retains the hook's typed local refusal | Other 25 hidden-completion tests passed, including genuine provider-failure controls |

Verification used Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**, and Vite
**6.4.3**, with every runner bounded by `timeout`:

* Full plugin suite: **6,618 passed, 4 skipped, 0 failed**, 202,380 assertions.
* Full Pi suite: **1,471 passed, 3 skipped, 0 failed**, 82,103 assertions.
* Scheduler/availability/command-handler/manual-selection regression rerun:
  **89 passed**, 710 assertions. This followed retaining the previous successful
  summary shape by omitting the optional `skipped` field when it is empty; the
  Pi owner's existing strict summary test was preserved, not rewritten.
* After restoring all controls, the rebuilt package passed the two real-host
  tests again and the four-file native history/refusal/availability selection
  passed **35 tests**, 161 assertions.
* Workspace and dashboard typecheck scripts passed. Plugin typecheck was also
  rerun after the summary-shape correction.
* Workspace lint passed (1,182 plugin, 220 Pi, 133 CLI, and 6 retina files);
  dashboard lint passed (63 files). Existing unrelated warnings/infos remain.
* Plugin package build passed, including its four server tests. Dashboard build
  passed (66 modules), and its suite passed **106 tests**, 359 assertions.

The standalone e2e project's `tsc --noEmit` still fails with **24 unrelated
existing/transitive errors** (old Bun-SQLite type mismatches, missing methods,
library targets, and host/global type conflicts). Scoped TypeScript diagnostics
for the new host fixture and updated manifest test are authoritative and clean.
This baseline is not evidence against the new host scenario and was not fixed
as part of these three defects.

An earlier plugin run hit an unrelated timing assertion in the busy backfill
test under machine contention; the full rerun passed it. Concurrent package test
scripts initially raced their frozen installs; serialized installs passed with
no manifest/lockfile changes. An earlier new source test bypassed the repository's
temporary-directory helper; it was corrected and the full source-policy guard
then passed. No live store or configuration was used in any of these checks.
