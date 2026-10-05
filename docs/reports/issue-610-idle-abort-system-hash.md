# Issue 610: an aborted idle refresh followed by a late system hash

## Completion follow-up: providers that omit usage

Review identified a loop left by a usage-only clock owner: after a model/provider
switch to responses without token accounting, the first expiry would remain
armed indefinitely. The corrected rule is **served response**, not **usage**:
positive usage without a failure is one proof; a non-failed terminal assistant
completion is another. No clock write is made merely for preparing a request.
Clock writes are monotonic: a delayed usage-bearing update cannot move the
clock back after a newer successful usage-less reply.

The shared `provider-response-completion.ts` predicate gives failure precedence
over finish/timestamps. An error object, or an error/abort/interrupted finish,
cannot refresh the clock. OpenCode 1 updates the clock even when its pressure
map is empty, before the no-usage early return, using the reported completion
time (or event time for finish-only updates). Native OpenCode 2 passes stored
finish/error/completion through its usage reader; omitted usage or an unknown
window still permits a completion-only clock write without zeroing the last
measured pressure. Legacy finish-only stored rows use a stable stored message
time, not a fresh timestamp on every reread. Pi/OMP stamp at successful
assistant `message_end`; their `timestamp` is the message **start**, not its end.

Real throwaway-host observations with all-zero usage:

| Host | Successful terminal record | Failed/aborted record | Clock result |
| --- | --- | --- | --- |
| OpenCode 1.18.30 | `finish="stop"`, `time.completed`, zero token fields | `error.name="MessageAbortedError"` and `time.completed` | success advances; abort does not |
| OpenCode 2.0.22 | `finish="stop"`, `time.completed`, zero token fields | `finish="error"`, `error={type:"aborted",message:"Step interrupted"}`, `time.completed` | success advances; interrupt does not |
| Pi 0.87.1 | `stopReason="stop"`, zero usage | real refusal: `stopReason="error"`, nonempty `errorMessage`, zero usage | success advances; refusal does not |
| OMP 18.2.6 | `stopReason="stop"`, zero usage | real refusal: `stopReason="error"`, nonempty `errorMessage`, zero usage | success advances; refusal does not |

Pi's pinned RPC `abort` waits for idle and did not acknowledge or emit a terminal
event in the held-stream probe (bounded at 5 seconds); no passing real Pi abort
is claimed. Its deployed assistant/stream API reports `stopReason="aborted"`
with `errorMessage` on cancellation, and the `message_end` unit fixture exercises
that distinct shape directly. The real Pi drive covers the successful no-usage
record and provider-error veto; OpenCode 1 and 2 additionally cover actual aborts.

The new portable host scenario first serves usage, switches to zero-usage
completion (an actual second model on OpenCode 1), ages the persisted clocks,
and observes **one execute**, followed by **defer** after the successful
zero-usage reply. Units independently switch model identities and prove the
same expiry-once invariant for all three clock writers. Reinstating usage-only
completion proof makes each named switch test fail at its clock assertion;
the old abort/error vetoes remain. The original midnight abort/resend real-host
cases pass unchanged after this completion correction.

The former native-v2 test inferred a refusal from zero tokens alone. It now
supplies an explicit error while retaining the assertion that refusal cannot
advance the clock; a separate successful no-usage test covers the broadened
contract. The rejection-pressure test still proves an old accepted reading
cannot overwrite newer rejection pressure, but now also requires the refusal
to leave the cache clock unchanged. The Pi test name was updated to describe
served assistants rather than incorrectly requiring usage for every success.

This follow-up introduces **no request-byte mutations**: it changes only
completion/clock persistence and decision binding. After one real expiry, a
successful usage-less reply closes idle ride permission and silent hash
adoption just as a usage-bearing reply does. An errored or aborted attempt
still leaves the original expiry armed. It needs no database migration.

Follow-up verification: 333 impacted OpenCode tests and 27 Pi tests passed in
separate package processes, both package typecheck scripts passed (TypeScript
5.9.3), and `bun run build` passed (Bun 1.4.2). The real OpenCode 1 switch case,
both original midnight abort/resend variants and warm-midnight control passed;
the native OpenCode 2 switch/interrupt case and Pi/OMP success/refusal cases also
passed. Three isolated red-before controls ignored usage-less successful
completion and failed the exact switch tests at timestamp assertions, then
restored with empty diffs. The e2e compiler scope has zero changed-file errors;
24 unrelated full-project diagnostics remain in that follow-up check.

## What the supplied trace proves

Read issue 610 and all five comments, the diagnostic attachment, and all 699 lines
of `magic_context_log_unattributed_cache_bust.txt` supplied subsequently.

The first idle expiry **was recognized**. At 12:58:31 the scheduler executed and
the head folded with `ttl_idle`. That attempt was aborted without provider usage;
its user and assistant messages were removed at 12:59:48. The resend deferred
using `lastResponseTime=1791032311768`, exactly the time of the preceding
postprocess's reasoning cleanup, not a served provider response. At 12:59:54 the
system hook changed the hash and queued a flush. The following tool step folded
with `system_hash` and applied more drops. The provider's two readings were
0/239,822 cached and 65,589/240,247 cached.

This is not missing timestamp restoration or a disagreement about `1h` parsing.
`runPostTransformPhase` advanced `lastResponseTime` on **preparing** an execute
request. The event handler's no-usage branch already avoids that write. The
aborted attempt never bound its decision to an answered assistant, and the
resend cleared the pending record and produced no new bust record. That explains
the first row's missing attribution. The second loss is the late system hook
queuing a second head rewrite after the first request had recached it.

## Changes and precise byte scope

* Remove the prepare-time response-clock write. Served responses remain the
  clock's owner, including successful completions without usage. The persisted
  materialization timestamp still consumes the
  first idle fold: an expired retry does not fold the same head twice.
* Price newly queued work on an expired retry even if its head was already
  prepared by the aborted attempt. That retry is still provider-cold.
* Record `execute / ttl_idle` for that retry's own assistant, even if it merely
  replays the prepared head (`materialized=0`). The existing dashboard mapping
  labels it **Idle cache refresh**, without inferring expiry from usage bars.
* On an idle-expired request, adopt the late system hash into
  `cachedM0SystemHash` without adding another history/materialization flush.
  Reuse the same strict `elapsed > TTL` predicate as the messages pass. A
  pressure-only scheduler execute is **not** proof of a full cache rebuild: it
  can serve identical, still-warm bytes. Warm system changes retain their fold.
  No new schema, migration, or provider-only cold-miss inference is introduced.

Compared with the old code, the passes whose bytes can change are exactly:

1. The first **genuinely expired** request can release the new date. That request
   was already a full provider-cache rebuild. Its head fold remains on that pass.
2. If that attempt is aborted before its system hook/answer, its still-expired
   resend can release the date and apply work queued after the aborted fold.
   That resend is still a full provider-cache rebuild; it reuses the prepared
   head rather than folding it twice. In the matched-order proof, the date was
   already in both versions' resend payloads, so only the reductions move here.
3. The next tool step no longer applies the old code's delayed system fold and
   reductions: it extends the resend prefix instead. This is the **removal** of
   a paid rewrite, not new mutations on a warm pass. Subsequent steps and warm
   turns only append the ordinary conversation tail.

The hash adoption itself changes metadata, not wire bytes. A normal warm turn
across midnight (no expiry, no abort) still sends Fri Oct 02 even when the host
offers Sat Oct 03, with identical prior messages, system and tool definitions.
That real-host control passes on both the published and changed versions.
Warm non-date system changes retain their existing fold.

## Real-host experiments

Host: OpenCode **1.18.30**, Bun **1.4.2**. Provider: throwaway Anthropic-compatible
mock, with a 1M context window and reported input usage of 240,000 (below 65%).
Three substantial provider replies seed the history. The local Claude estimate
was about 225k tokens in ordinary drives; one published drive produced an extra
host request during seeding and reached about 300k before reduction. Actual
request sizes and estimates are recorded, not silently equated to mock usage.

The published package was fetched using
`npm pack @cortexkit/opencode-magic-context@0.44.4` (npm 11.13.0), SHA-1
`7c5f9efec4748e80604a746ef6dd2e1851f2f69a`, integrity
`sha512-4L2QmQFFCHPvwE750yMJ1J0IZh99g1XEkwk6mP8v1wrFlYsMM8WUrdrzXax1gkxPC8kAJB2gf/bOV7w2pazRuA==`.
Its unmodified bundle, not source inferred from the tag, was loaded. Its external
peer dependencies resolve through this worktree's installed plugin dependencies.
It initialized only a fresh throwaway database.

### An important host-order distinction

The CLI observed the system hash **before** its messages transform in the initial
unmodified-host probe; that configuration moved the system fold onto the resend
already, so it reproduced the bad idle clock but not the second-step byte loss.
The reporter's Desktop trace explicitly observes the system hash **after** the
messages pass. The test-only wrapper reproduces that order on the real CLI:
it renders guidance in a provisional render-only session before serialization,
seeds the previous instance's durable hash from the actually rendered Oct 02
system text, and observes the real session's Oct 03 hash after messages. The
aborted attempt deliberately never reaches that real observer, matching the
absence of any system-hook log for that attempt in the reporter's trace. It
does not change the bundle, scheduler, materializer, transport or host binary.
Assertions inspect the **actual request payloads**: the seed carries Fri Oct 02
and the returning request carries Sat Oct 03 inside `<env>`. Array entries are
mutated in place because the host retains that system-array reference.

The scenario ages both historical timestamps together (at least 16.5 hours,
and before UTC midnight for the date cases, preserving response-after-fold
ordering), holds the first mock response, calls the host's
abort and revert endpoints, queues one more old-text drop, and resends into two
actual bash calls and a final assistant response. Both continuous-host and
host-restart variants were driven before and after the change.

| Reporter-order drive | Resend decision | Later `system_hash` fold | Step 1 prefix retained on step 2 |
| --- | --- | --- | --- |
| Published 0.44.4, continuous | defer; no idle row | yes, one queued drop | 301 / 2,456,124 message bytes |
| Published 0.44.4, restart | defer; no idle row | yes, one queued drop | 301 / 2,456,124 message bytes |
| Changed worktree, continuous | execute / ttl_idle, materialized=0 | no | 1,842,328 / 1,842,328 bytes |
| Changed worktree, restart | execute / ttl_idle, materialized=0 | no | 1,842,328 / 1,842,328 bytes |

Before, the message-prefix SHA-256 changes from
`ed439e1ee9348677be70575226df22bc0f0dab946183f72e4051a81ebb6d12a2`
to `71f822cf192b8cd5a003f58ba28f5744b43666a30fd892d269fb6dbb9d74799c`.
After, both step prefixes have the latter digest. Steps 2→3 and 3→next user turn
also match. Comparisons exclude only advancing `cache_control` breakpoints;
raw request payloads retain those fields. The small surviving message prefix
plus unchanged upstream system/tool definitions explains the position of the
second loss; this mock's tool definitions are not the reporter's Windows tools,
so it does not pretend to reproduce the literal 65,589-token cut or actual
Anthropic cache accounting.

## Why the system hash changed

The reporter subsequently compared complete request payloads and identified
`Today's date: Fri Oct 02 2026` becoming Oct 03 inside OpenCode's `<env>`.
`system-prompt-hash.ts` originally released a sticky date only when
`systemPromptRefreshSessions.has(sessionId)` was set, or a **non-date**
content/preset change had already altered the stable candidate hash. It did
**not** consult the scheduler decision or provider idle clock. TTL materializing
the head did not add that system-refresh flag. Thus an existing sticky map could
keep yesterday's date even on the first expired pass.

Separately, that sticky map is handler-local, while the hash is durable. A cold
handler adopts the first live date it sees. The first-pass reset/LKG hydration is
consistent with recreated plugin state without a Desktop process restart. The
aborted 12:58 attempt logs a completed messages transform but **no system hook**;
the first logged system call is on the resend. The aborted prepare-time clock
write had meanwhile made the resend look warm. A cold handler then saw Oct 03
against the durable Oct 02 hash and scheduled the later fold.

The fix reads the persisted served-response clock in the system hook itself, so
it releases the date on the expired attempt if that hook runs, or on its still-
expired resend if not. It does not depend on hook order or a transient refresh
flag. The real-host no-abort expired-midnight case releases Oct 03 on the first
rebuild, whereas the warm-midnight control freezes Oct 02 and matches bytes.

The billing header is not an explicit exclusion in MC's MD5 function: MC hashes
all strings it receives in `output.system`. For the reported route it is added
downstream, not to that hook's input: the reporter sees it change every request,
but the full trace records only one system hash transition, at the date change.
The OMP drive likewise exposes its generated billing checksum in the raw provider
request outside the Pi prompt processor's input. No production billing-header
normalization was added as part of this fix.

## Other harnesses and limits

Pi and OMP already stamp the idle clock only for answered provider messages
(`index.ts: persistPiMessageEndModelMeta`, near 830). Their system hash is
processed in `before_agent_start` (`index.ts`, near 2421), before context, so
the late OpenCode 1 flush order is not shared. However their own copy in
`system-prompt.ts: processSystemPromptForCache` had the same flag-only date
release omission. It now also checks the shared idle predicate. The date/hash
change is then consumed by their first expired context pass, not a later step.
Warm-versus-expired midnight unit controls cover that copy; real-host first-
expiry and next-prefix replay are covered. Pi's decision binding occurs on the next context
pass; OMP currently writes that decision under harness `pi`. OMP also adds a
per-request `x-anthropic-billing-header` checksum: raw evidence retains its
change, while the assertion compares all system instructions without that
host-generated billing block.

Native OpenCode 2 uses the same system handler and TypeScript messages delegate
(`v2/hooks/context.ts`, near 1330/1356), so it shares both fixes rather than having
a separate date implementation. Its own accepted-usage clock writer is already
usage-gated (`v2/hooks/usage-persist.ts:66-67`). The v2 repro ages the host's
`session_message.data.time.completed` too, because native v2 re-reads that source
and correctly replaces an artificially older MC timestamp. It folds at first
expiry and replays next. Its native usage hook
does not bind the v1 delegate's pending `transform_decisions` row; that telemetry
gap is recorded rather than fixed outside this change.

The subsequent [Rust follow-up](issue-610-rust-idle-abort-system-hash.md) repairs
and verifies the module path described below; the original investigation's
unverified boundary is retained here for chronology.

Rust's clock is forwarded by `rust-mode-transform.ts`, near 3375/3678, as
`observed_last_response_at_ms`; the module constructs scheduler input from it
(`crates/mc-module/src/transform.rs`, near 3052 and 4370). Its strict idle
predicates are in `scheduler.rs:465-472`; the scheduler's idle result is computed
near 768. It does not use the removed TS postprocess write: the Rust branch
returns before that pipeline. Thus the **prepare-time clock removal** and the
new **TS expiry-only decision fallback** in `transform.ts` are TS-delegate fixes.

The host's shared system hook can release the date in Rust mode too, but adopting
`cachedM0SystemHash` acknowledges only the TS head. Rust maps the system identity
in `rust-mode-transform.ts:2931-2936` (including a special omitted-first-hash
case), and its module persists `meta.last_system_prompt_hash` and classifies a
later identity change (`transform.rs`, near 4535/4988). Rust attribution comes
from the module response via `writeRustTransformDecision` in
`transform-decision-log.ts:179`, not the added TS expiry fallback. Module-side
identity adoption and abort/resend attribution are **not claimed verified or
repaired** here.

A Rust repro needs a current-tree ck-mc/ck-subc pair, isolated context.db and
store.db, module PID lsof inventory, the same old-date/expired/usage-less-abort
and late-observer fixture, and request plus module-decision capture for all
three returning steps. It must check the module's frozen identity, not just the
TS cached marker. A hermetic current-tree release build timed out after
900 seconds on the shared, heavily queued compiler host, before a runnable
module existed. No second heavy build was launched. The new scenario is
registered as TS-only, with manifest counts updated. Rust real-host verification
and any independently necessary module identity adoption remain a review gap.
The parent explicitly accepted the verified TS delivery and owns that follow-up;
no second Rust build was started.

## Isolation, artifacts and reproduction

### Verification and red-before controls

* Final OpenCode 1 matrix: 10 passed, covering ordinary expiry/restart, four
  large-history loops, warm and expired midnight, and both abort/resend variants.
* Published 0.44.4 midnight controls: the normal warm case passed; the expired
  date-release case and both abort/resend cases failed (1 pass, 3 named failures).
  The before/after table above comes from those actual request captures.
* OpenCode/Pi shared-hook unit checks: 347 passed across seven OpenCode files
  (including v2 restart and usage persistence), plus 19 passed across two Pi
  files. The Pi warm control stays green when expiry date release is neutralized.
* Manifest, prerequisites, mock routing and OpenCode runner checks: 19 passed.
  Pi, OMP and OpenCode 2 real-host ordinary expiry checks: two passed per host.
* Both package typecheck scripts passed with TypeScript 5.9.3. The e2e project
  has 25 unrelated baseline diagnostics (notably old SQLite type mismatches and
  stricter native-v2 test typings); a compiler-API scoped check reports zero
  diagnostics in all four changed e2e TypeScript files. No baseline was repaired.
* `bun run build` passed for the OpenCode, Pi and CLI distributions; Bun 1.4.2.

Each silent fence was challenged after staging the live implementation, with a
non-empty mutation diff captured and an empty diff after checkout/touch restore:

1. Restoring the old prepare-time clock write reddened only
   `preparing an execute request does not refresh the provider response clock`.
2. Neutralizing expired-system adoption reddened only
   `adopts a late system change on an expired request`; the warm flush control
   passed in the same run.
3. Neutralizing the Pi expiry-date predicate reddened only
   `releases the midnight date on an expired provider cache`; its warm freeze
   control passed in the same run.
4. Appending a marker in the real messages transform on a warm defer pass
   reddened only the continuous-host aborted-idle regression **at assertReplay**.
   This altered the actual serialized provider request, not the captured proxy.
   The same named real-host test passed after restoring the source.

All mutation markers were restored; none remains in production.
The completion follow-up below also removes the rejection-derived clock write
from `storage-meta-persisted.ts:recordOverflowDetected`. It still records recovery
pressure, but a provider refusal cannot refresh the response clock.

All XDG data/config/state/runtime roots, `OPENCODE_DB` and
`MAGIC_CONTEXT_STORAGE_DIR` were throwaway paths under
`$TMPDIR/magic-context/issue-610/`. OpenCode 1 now also uses a throwaway HOME so
its non-XDG `~/.opencode` scan cannot reach operator configuration. Host PID lsof
inventories were checked with the OC2 runner's forbidden-path guard and contain
only throwaway `.db` paths. OC2 uses its existing process-group/inode guard.
No live store or live configuration was opened, read, written or migrated.

Full requests, logs, decision rows, hashes, and lsof inventories are in
`$TMPDIR/magic-context/issue-610/evidence-{published,fixed}/`.
The `*-long-loop-plain-abort-system.{json,log}` files are the matched-order proof.
Other files cover plain expiry, queued work, ordinary multi-step turns and the
`warm-midnight.json`/`idle-midnight.json` date controls.

Run the checked-in regression with:

```sh
mkdir -p "$TMPDIR/magic-context/issue-610"
timeout 300s env TMPDIR="$TMPDIR/magic-context/issue-610" \
  IDLE_TTL_EVIDENCE="$TMPDIR/magic-context/issue-610/evidence-fixed" \
  bun test packages/e2e-tests/tests/idle-ttl-restart.test.ts
```

`IDLE_TTL_LONG=1` adds the four ordinary large-history probes. `MC_E2E_HOST=pi`,
`omp`, or `opencode2` selects the portable idle cases. For the published
comparison, set `IDLE_TTL_RELEASE=0.44.4` and `MC_E2E_PLUGIN_ENTRY` to the unpacked
published `dist/index.js`. That deliberately leaves database initialization to
the published plugin in its fresh fixture. Allow a larger overall timeout when
running all ten OpenCode cases on a busy source-loading host.
