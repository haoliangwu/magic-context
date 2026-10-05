# Rust hermetic CI failures: history, causes and repairs

## CI history

The reported lower bounds were too recent. `gh run list --workflow ci.yml
--branch master` and the failed-job logs establish these first **observed CI
failures**, independently of the later issue 610 Rust merge:

| File in `packages/e2e-tests/tests/` | First failing master push | Cause and repair |
| --- | --- | --- |
| `rust-compaction-marker-byte-identity.test.ts` | `4d650770462c142fa8b774173b02a17cec2239d7`, run **37063647666** | An intentional module restart invalidated the adapter's cached route. The SDK refused the stale handle locally, without sending a transform. Treating that refusal as an interrupted, possibly committed transform made the control request fail without a last-good request. Rebind the locally unsent handle; preserve refusal after dispatched requests. The test and its byte assertions are unchanged. |
| `rust-park-self-heal.test.ts` | Same push/run | The same locally unsent refusal unnecessarily entered the LKG freeze. Later successful warm transforms correctly replayed the frozen request, so none reported `served_from=transform`. Repair the stale-route boundary rather than forcing an unpriced exit from the freeze. All six existing recovery/refusal tests are unchanged. |
| `rust-restart-variant-double-hard.test.ts` | Same push/run | The stale handle prevented the first restarted pass from reaching `need_full_sync`; subsequent passes used the LKG freeze. Repairing that unsent boundary restores the existing full-array path. The test still demands the full retry, four applied `SOFT+` passes, and the unchanged variant-bearing render identity. |
| `rust-adapter-perf.test.ts` | Same push/run | Negotiated reply paging made the large defer reply four physical frames, not one unary frame. The profiler counted physical frames correctly; the assertion was obsolete. Track the first envelope's page total and compare it with the actual decoded frame count. Also check the unary loopback count, complete output length, and exact prior serialized-message prefix on each defer. |
| `idle-ttl-restart.test.ts` | `545d5f229f136e2f9e6b7803efd1021011312379`, run **37167496592** | The test wrapper assumed system-before-messages order. With the pinned CLI's messages-first order it observed the returning request's hash on the **next warm tool step**, after the reply had spent expiry. Observe the same request after its messages pass in either hook order. A separate fixture accounting error equated provider request count with transform-log count; Channel 2 nudges can add a provider request without another messages transform. Wait for the completed transform, retaining every provider capture and every byte-identity assertion. |

The immediately preceding master run **37059509601**, at
`07aa159dd678672c23c895544dc921205e28c9ba`, had all four Rust shards green.
Between those pushes, `fd1ccdf79056959c6128adb6dd358a6f10c9c743` was merged as
`cfd136a94e246e283b9d38c0a6d008cd057cf5ec`. That change introduced negotiated
reply paging and the blanket interrupted-transform refusal responsible for the
first four failures. There was no separate master run at that merge in the
retrieved run list, so the first observed push is distinguished from the causal
implementation commit above.

The idle test was added to the **Rust** manifest at `545d5f229f`; it was absent
from the preceding Rust shard inventories. Its first Rust failure is not
evidence that the Rust idle-clock implementation caused the earlier restart or
performance failures. The later run **37187634754** reproduced these failures;
the frame-cap changes did not originate them.

## Safety boundary

Ordinary failed managed passes must still replay a verified last-good request or
refuse. Serving raw input after an unknown-outcome transform, especially without
a last-good request, would be unsafe. The degraded-pass refusal changes are not
reverted.

The pinned `subc-client` **0.11.1** throws `StaleRouteHandleError` from
`request()`'s local handle check **before** allocating/sending the request. Only
that exception's name and code qualify as unsent proof. A remote error with the
same code decodes as `SubcError` and is not proof. An already received initial
reply, a later stale page, a dropped socket, a deadline, and a generation-sensitive
page all retain the existing abandon/replay/refuse behavior. There is no
automatic retransmission of a dispatched transform, test retry, timeout increase,
new skip, or change to the CI runner.

The prior status-route recovery test now explicitly covers both status and
transform, asserting only the two intended requests reach the peer. Additional
controls cover stale partial replies and remote stale-code lookalikes. The
original connection-loss, deadline, partial-reply and generation-change controls
remain green.

## Verification

Tools: **Bun 1.4.2**, **OpenCode 1.18.32**, **TypeScript 5.9.3**, **Biome 2.5.1**,
**cargo 1.99.0**, **rustc 1.99.0**. The worktree built both binaries sequentially
into `packages/e2e-tests/.cache/rust-e2e-cargo-target`, then copied them into
`.cache/prebuilt`. The unchanged module reports
`ck-mc 0.1.0 (81e2acdd3c1757994dd839f1b3576c70a787fb95)`; the daemon reports
`ck-subc 0.20.55`. Builds took **2m38s** and **6m13s**, including a shared-slot
queue; they were not blocked. No Rust source changed.

Each of the five files passed **twice in fresh processes on the final
implementation**, using the CI Rust mode, explicit worktree-built binary pair,
pinned host, `NODE_ENV=""`, and the existing
`bun test --timeout 600000 --max-concurrency=1 <file>` invocation:

| File | First final run | Second final run |
| --- | --- | --- |
| Compaction marker byte identity | 1 pass, 0 fail | 1 pass, 0 fail |
| Park self-heal | 6 pass, 0 fail | 6 pass, 0 fail |
| Restart variant | 1 pass, 0 fail | 1 pass, 0 fail |
| Adapter performance | 1 pass, 0 fail | 1 pass, 0 fail |
| Idle TTL restart | 7 active pass, 0 fail | 7 active pass, 0 fail |

The idle file's existing four opt-in long-loop cases and non-OpenCode mode cases
remain outside this CI selection (37 existing skips). All originally failing
cases execute; no skip was introduced as a repair. The marker control and both
marker replays have SHA-256
`a3109befd3ba63a72dbbb7eb653bc28d24999a71282fc1827bcb5a95052d7298`
in both runs. Restart-variant decisions are four `SOFT+` passes in both runs.

Other gates:

* Plugin impacted suites (`module-transport`, `reply-pages`, `rust-mode-transform`,
  and the isolated-home config control): **209 passed**, 0 failed, four files.
* Full Pi package script: **1,487 passed**, 0 failed, 137 files; its three existing
  skips are unchanged. Its frozen install checked 995 installs without changes.
* Plugin and Pi package typecheck scripts: passed with TypeScript 5.9.3.
* E2E compiler-API check: all three changed E2E files have **zero scoped
  diagnostics**. The E2E project still has **25 unrelated diagnostics**.
* Plugin package lint script: **1,196 files checked**, no fixes/errors.
* Plugin package build: passed, including its four v2 loader tests. The Pi dist
  was already built by worktree preparation and is unchanged.
* Rust clippy/mc-module tests: not required for this TypeScript-only repair; no
  Rust source, Cargo manifest, lockfile, schema, or generated Rust output changed.

The full plugin suite was also run: **6,727 passed**, three failures. Two are
unrelated source fences: an unlisted deferred transaction in
`message-fts-session-filter.ts:72`, and an unregistered temp-directory helper in
`e2e-tests/src/live-providers/auth.test.ts`. Both offending sources and both
guards are unchanged from the base. The third was the home-expansion fixture
comparing a normalized path with our initially double-slashed throwaway HOME;
that fixture passes with canonical HOME spelling in the final 209-test run.
The initial Pi home fixture failure likewise disappeared with canonical HOME;
the final full Pi suite is green. These unrelated source fences were not edited.
This repair does **not** claim every job on master is green.

## Non-vacuity and isolation

Two staged-live-state mutations used the exact `NON-VACUITY BREAK` marker,
captured a nonempty diff, ran the complete 34-test transport file, restored with
`git checkout -- <path> && touch <path>`, and captured an empty diff:

1. Removing the initial-response guard reddened only **does not rebind a stale
   reply page after the transform already answered**: an extra transform request
   appeared. The other 33 tests stayed green, including the remote-code control.
2. Removing the SDK exception-name check reddened only **does not treat a remote
   stale-route code as proof the transform was unsent**: expected one request,
   received two. The other 33 tests stayed green, including the partial-page
   control. Restored transport plus reply-page suites pass all **38 tests**.

Hosts, daemon, module, unit HOME and XDG roots ran under
`$TMPDIR/magic-context/bg_0963b4bf5848658d/`. The idle suite's existing lsof/open-path
checks remained active. No live store or live configuration was an input; no
operator database was read, written or migrated. A reboot/restart erased the
first throwaway host install, so the pinned host was reinstalled and the final
two-run matrix explicitly checked **1.18.32** before and after execution.

Final E2E logs are retained in the worktree's ignored
`packages/e2e-tests/.cache/ci-repair-evidence/*.final{1,2}.log`. Downloaded CI logs
and scoped/unit/build/mutation logs are ignored worktree artifacts, not shipped
files. The reboot checkpoint commit's outstanding items are superseded by this
report.
