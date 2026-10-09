# Live cache TTL: the fixture raced a terminal response-clock write

## Finding

Reproduced the original five-second `expired turn transform decision` timeout
twice on **OpenCode 1.18.35**, before changing the test. The expired pass really
ran, loaded **1h**, and **deferred**: its idle clock had been restored to the
previous assistant's completion time. It legitimately produced **no new row**.
This is a fixture/event-ordering race, not delayed telemetry, an earlier pass's
timestamp, title generation, or failure to load the live policy. No product code
is changed, and neither five-second wait nor the overall test timeout is raised.

At worker base `89f92bcc`, the relevant production path is:

- `hooks/magic-context/transform.ts`: clears pending attribution at pass entry;
  samples the live TTL during session-meta preparation; at the post-transform
  tail records a pending decision only for `bustedThisPass || hardCacheExpired`.
  **`ts_ms` is `Date.now()` at that tail**, before the provider request, not pass
  start, request preparation, assistant completion, or SQLite insertion time.
- `hooks/magic-context/event-handler.ts`: a successful terminal assistant update
  binds the pending decision to that assistant's `messageID`. Independently,
  usage-bearing updates persist `last_response_time`; terminal updates use the
  host's `time.completed`, while earlier usage updates use the current time.
- `features/magic-context/transform-decision-log.ts`:
  `scheduleOpenCodeTransformDecisionWrite` schedules `setTimeout(0)`, retaining
  the pending pass timestamp. `writeTransformDecisionRowOnDatabase` performs the
  insert. Writes are best-effort with zero busy timeout. An unchanged warm defer
  stages nothing; a defer that actually busts (e.g. seed `first_render`) can have
  a row. The scheduler log covers non-busting defers.

The original `busy_timeout=5000` handles a writer holding a SQLite lock. It cannot
order a fixture UPDATE ahead of a host update that has not started yet. The
prompt HTTP response does not await the plugin's terminal event handling.

## Failed-run evidence

All times below are UTC on 2026-10-07. The original test performs its `1h` edit
between the raised prompt's response and creation of the final user message.

| 1.18.35 loaded run | PID / retained fixture | Raised assistant `time.completed` | Expired scheduler / observed idle clock |
|---|---|---|---|
| 10 | 98770 / `opencode-e2e-GfPl3O` | `1791334519114` (00:55:19.114) | 00:55:19.136: `cacheTtl=1h lastResponseTime=1791334519114 decision=defer` |
| 26 | 69618 / `opencode-e2e-Lskt73` | `1791334707248` (00:58:27.248) | 00:58:27.281: `cacheTtl=1h lastResponseTime=1791334707248 decision=defer` |

The clocks exactly match the **previous** assistant's durable host completion
times, not the fixture's two-hours-old time. In run 10, its usage and terminal
events are logged at .113 and .117; the next user is created at .121. In run 26,
those events are at .247 and .250; the next user is created at .255. Both final
passes complete (at .150 and .298 respectively) and both assistants answer.
There are four ordinary transform passes in each log; no pre-prompt/title pass
consumed an expiry. The only durable decisions, still present after the timeout
and host shutdown, are:

| Run | `message_id` | `ts_ms` | decision / reason |
|---|---|---|---|
| 10 | `msg_113db81fd001V46eIrLzYp1KWP` | `1791334518363` | `defer / first_render` |
| 26 | `msg_113de627e0019aj75eLzClZWDK` | `1791334706736` | `defer / first_render` |

## Test change and checks

Before backdating the clock, wait until Magic Context's `last_response_time`
equals the returned assistant's positive `time.completed`. This fences the
terminal clock update, rather than merely the earlier usage update. Apply this
to the seed turns as well as the raised-TTL turn. Select expired-turn telemetry
by **that assistant's message ID**, not a wall-clock cutoff. Capture decisions,
clocks, and returned assistant metadata in the existing per-PID diagnostic JSON.

The warm assertion now reads the single session scheduler line appended during
that prompt and requires `13h/defer`. The old `latest decision == defer` assertion
was reading the seed's `first_render` row, not proving the raised turn deferred.
The execute/`ttl_idle`, saved config provenance, on-disk edits, and byte-identical
warm system/tools/message prefix assertions remain intact.

macOS arm64, Bun **1.4.2 (744846f84)**; both exact host versions were installed as
`opencode-ai@<version>` under the throwaway task root and probed with `--version`.
Each batch ran two continuous CPU burners alongside sequential fresh hosts:
`bun -e 'while (true) { for (let i=0;i<1000000;i++) Math.sqrt(i) }'`.
Each iteration used the package command:
`bun run --cwd packages/e2e-tests test tests/cache-ttl-live-config.test.ts`.

| Version | Original, loaded (30 runs) | Fixed, loaded (30 runs) |
|---|---|---|
| 1.18.35 | 28 pass, 2 timeout | **30 pass, 0 fail** |
| 1.18.30 | 30 pass, 0 fail | **30 pass, 0 fail** |

Each fixed run executed one test / 27 assertions and retained exactly two rows:
seed `first_render` and the final assistant's execute/`ttl_idle`. Mutation control:
temporarily replace the transform's live policy sampler with its boot policy,
marked `NON-VACUITY BREAK`, then rebuild the production bundle. Only
`OpenCode 1 live cache_ttl edits affect the next idle check without changing prompt identity`
reddened: expected `13h/defer`, received `1h/execute`. The four bundle contract
tests stayed green. The mutation's unstaged diff was one file, +2/-1; restoring
the staged source and touching it returned the unstaged diff to empty. Rebuilt
the unmutated bundle and reran the exact 1.18.35 test: 1 pass / 27 assertions.

Additional gates: package build passed (Bun 1.4.2, embedded v2 contract tests 4/4);
scoped `tsc --noEmit` passed (TypeScript **5.9.3**, changed test and imports,
temporary config extending e2e config with Node types and retina path mapping);
scoped diagnostics reported zero errors/warnings. Broad e2e typecheck has 19
unrelated baseline errors (SQLite backend types, old test APIs, missing retina
paths, readonly ignore field); these were not changed.

## Isolation and artifacts

Let `R` be `$TMPDIR/magic-context/bg_90749c62c42f88d3` using the original system
TMPDIR. The 120 loaded runs, mutation and corrected smoke run used outer
HOME/CFFIXED_USER_HOME `R/home`, TMPDIR `R/tmp`, and all five XDG directories,
OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR under `R`. The harness further isolates
HOME, XDG directories and both databases in each fixture. `lsof` ran while each
host was alive; an audit of all 120 saved fixture inventories checked **1,556
database descriptor rows**, all beneath their respective throwaway fixture.
No live stores were opened or modified. One auxiliary smoke command continued
after a temporary type-config error and used an empty outer ROOT: its version
probe failed `EROFS /data`, and its fallback 1.18.30 harness run remained entirely
under `/private/tmp/magic-context/issue-624` by `lsof`. It is excluded from the
versioned verification; the command was corrected and rerun with fail-fast shell
handling and the explicitly installed 1.18.35 host.

Retained evidence under `R` (not committed):

- `logs/{baseline,fixed}-<version>-<iteration>.log`, `logs/loaded-runs.json`;
- `logs/baseline-1.18.35-{10,26}-rows.json`: all failed-run decisions, session
  clocks, and durable host messages including completion times;
- `tmp/magic-context/issue-624/host-plugin-{98770,69618}.log`, per-PID run/stdout/
  stderr/lsof captures, and retained fixture databases;
- `logs/mutation-live-ttl.log`, `logs/tsconfig.ttl-triage.tmp.json`.

The supplied CI run ID was not resolvable in this repository; this report proves
the same timeout locally at the worker base, rather than claiming access to
those CI artifacts. Rust/OpenCode 2/full fleet gates were not run for this
test-only fix. ARCHITECTURE.md, STRUCTURE.md, manifests and lockfiles are unchanged.
