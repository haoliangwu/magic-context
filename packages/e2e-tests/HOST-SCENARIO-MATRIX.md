# Host scenario matrix

Status revalidated on 2026-09-19 against OpenCode 1, OpenCode GA 2.0.5, Pi, and OMP after
per-host adjudication. `declared-divergence` means the host is named in the manifest entry's
`divergences` array and the cited host surface cannot express the OpenCode behavior;
`product-bug` means the real-host run still fails. A passing divergent branch is not a claim
that the missing v1 mechanism exists on that host.

| Scenario | OpenCode | OpenCode 2 | Pi | OMP |
| --- | --- | --- | --- | --- |
| cache invariants | pass | pass | pass | pass |
| cache stability | pass | pass | pass | declared-divergence |
| compaction off | pass | pass | pass | pass |
| conflict disable | pass | pass | pass | pass |
| context limits | pass | pass | pass | pass |
| deferred compaction marker | pass | declared-divergence | declared-divergence | pass |
| dropped-input guard | pass | pass | declared-divergence | declared-divergence |
| drops | pass | pass | pass | pass |
| emergency blocking | pass | pass | pass | pass |
| historian success | pass | pass | pass | pass |
| long-running session | pass | declared-divergence | pass | declared-divergence |
| memory injection | pass | pass | pass | pass |
| notice-loop race | pass | declared-divergence | declared-divergence | declared-divergence |
| overflow recovery | pass | pass | declared-divergence | pass |
| session isolation and removal | pass | pass | declared-divergence | declared-divergence |
| short-context overflow | pass | pass | pass | pass |
| slow historian | pass | pass | pass | pass |
| smoke | pass | pass | pass | pass |
| subagent behavior | pass | declared-divergence | declared-divergence | declared-divergence |
| tag-owner collision | pass | pass | pass | pass |
| tagging | pass | pass | pass | pass |
| thinking-block safety | pass | declared-divergence | declared-divergence | declared-divergence |
| todo synthesis | pass | declared-divergence | pass | pass |
| window overlay reload | pass | pass | pass | pass |
| Pi cross-harness | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 1 | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 4 | declared-divergence | declared-divergence | pass | declared-divergence |

## OpenCode 2 repair evidence (2026-09-19)

- Context limits: adapter now persists completed assistant usage on `session.execution.succeeded` and feeds the resolved model catalog into shared budget arithmetic; harness output limit matches the other hosts (8,192). Exact real-host assertion: `47.83773440489858` for 20,000 / 41,808.
- Cache invariants: v2 now applies the shared system-guidance/hash handler; the scenario harness uses Anthropic transport like the other hosts so the existing wire oracle sees the actual provider request.
- Long-running session: retain real notes, drops, cache replay, range-matched publication, memory, and continued-session assertions; replace unavailable native todo triggers with the verified absence contract and v1 marker drain with a zero-request GA fold.
- Overflow recovery: inspect GA primary `http.response` errors before host retry handling, persist the shared detector's limit/recovery state, and let the existing historian path clear recovery.
- Deferred compaction marker: execute the existing manifest divergence by requiring historian publication, no v1 pending blob, a completed GA-owned checkpoint, and zero extra provider calls for the fold.
- Conflict disable: the equivalent GA safety property is no competing summarizer; the real compaction hook is answered locally and the next provider request retains its checkpoint.
- Todo synthesis: GA has no native todo writer; the OC2 branch verifies the real tool inventory and empty durable todo state. A real-host tool-registration mutant makes this assertion fail.
- Dropped-input guard: select GA's `shell` tool instead of v1 `bash`; the unchanged refusal and recovery-message assertions pass on the real host.
- Window overlay reload: include the OC2 model key in the fixture and preserve mock usage across restart; exact initial and reloaded percentages pass.
- Compaction off: retain memory/tool registration, pass the shared compaction-off mode, and bypass v1-only synthetic marker deletion for GA-owned checkpoints.
- Memory injection: register the shared ctx_* implementations with the GA tool editor using JSON Schema; a real ctx_memory write is now present in a fresh session's first request.
- Historian success: Anthropic transport allows the shared historian mock matcher to return the publication payload; real-host publication now passes.
- Session isolation and removal: GA `session.remove` emits `session.deleted` with `data.sessionID`; subscribe to it and clear durable rows plus per-session adapter state.
- Emergency blocking: reserved-output pressure reaches shared historian recovery while the raw host-window admission fence remains intact; successful usage above a stale catalog window is not treated as proof of imminent overflow.
- Cache stability: restored system guidance and Anthropic wire transport allow the unchanged prefix/system byte-stability oracle to observe real main-agent requests.
- Short-context overflow: terminal usage and catalog budgets now reach the scheduler; the unchanged accumulating-pressure recovery scenario passes.
- Slow historian: real Anthropic transport reaches the historian matcher while unchanged foreground responsiveness assertions pass.
- The first usage-only rerun still failed downstream scenarios, refuting a single-root explanation. Subsequent repairs address tool registration, lifecycle, system guidance, overflow errors, and host-specific carriers; no v1 assertion was removed.

## Reproduction summary

- OpenCode 1 manifest lane: 54 passed, 0 failed. The separately excluded overlay
  reload scenario also passed. All 52 pre-fold test names remained present; the
  two new canonical `drops` and `tagging` scenarios account for the increase.
- Pi manifest lane: 41 passed, 0 failed after corrections (21 files). The focused
  overlay scenario also passes. The two Pi-only Rust degradation files were not
  rerun in this adjudication; their prior record was 6 passing tests.
- OMP baseline reproduced: 19 passed, 21 failed, one setup error across 20 files.
  Final manifest lane: 36 passed, 0 failed, 0 errors across 18 files; the focused
  overlay adds one passing test. Removing two declared-divergence files removes
  four tests (including their non-failing companions), not just the two red tests.
  Corrected configuration and fixtures pass the independent historian, memory,
  todo and overflow assertions. Two whole-system scenarios are now declared
  host-imposed divergences; later long-session OMP phases are not claimed tested.
- Window overlay: Pi and OMP now persist `21.784593935169045` for the 100K
  overlay and `13.174536256323776` after a 160K rewrite plus reload. The stale
  value before reload remains asserted. OpenCode 2 now passes the same exact assertions.
- Pi manifest lane: 41 passed, 0 failed. The two Pi-only Rust degradation files
  passed 6 tests. The excluded overlay scenario reproduces the product bug below.
- OpenCode 2 manifest lane: **34 passed, 0 failed across 20 selected scenarios**
  (187 assertions). The original baseline was 12 passed / 29 failed. The lower
  test count reflects replacement of the unavailable native-todo cases with one
  explicit live-host divergence test, and removal of failure-only teardown errors;
  it is not 41 original tests silently made green. The excluded overlay scenario
  separately passes its three exact-pressure assertions. The dedicated real-GA
  `tests/opencode2/` regression lane is **48 passed, 0 failed** (494 assertions).
- Shared cleanup seam safety: v1 TS pure-replay differential is byte-identical on
  all four defer passes against `5efbe9b78b031156e44c00082fff385e48c46e46`;
  OpenCode 1 remains 54/0 and Pi remains 41/0.

Commands:

```sh
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  $(bun scripts/validate-mode-manifest.ts --mode ts --harness <host>)
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  tests/window-overlay-reload.test.ts
MC_E2E_MODE=rust MC_E2E_HOST=pi NODE_ENV='' bun test --timeout 600000 \
  tests/pi-rust-degradation-arc-1.test.ts tests/pi-rust-degradation-arc-4.test.ts
```

## Changed-row reasons (Pi/OMP adjudication)

| Row | One-line reason |
| --- | --- |
| cache invariants | HARNESS GAP: shared config enables publication; seeded m[0]/m[1] memories now use OMP's macOS cwd identity. |
| cache stability | HOST-IMPOSED: OMP hashes each body into `system[0].cch`, so whole-system bytes cannot stay fixed. |
| compaction off | HARNESS GAP: load the requested off-mode config and seed memory under the host's directory identity. |
| conflict disable | HARNESS GAP: OMP reads auto-compaction from `config.yml`, not `settings.json`. |
| deferred compaction marker | HARNESS GAP: shared user config enables the real OMP historian and native marker path. |
| emergency blocking | HARNESS GAP: shared user config supplies thresholds and the mock historian model. |
| historian success | HARNESS GAP: corrected configuration yields a real OMP child request and committed compartment, without changing spawn code. |
| long-running session | HOST-IMPOSED: phase-1 whole-system identity fails on OMP's attestation; Pi also needed an applied-native-marker reader rather than OpenCode's SQL column. |
| memory injection | HARNESS GAP: expose extension tools and invoke the advertised `_ctx_memory` name. |
| overflow recovery | HARNESS GAP: corrected configuration enables historian recovery and clears the recovery state. |
| short-context overflow | HARNESS GAP: distinct 20KB records avoid OMP's loop rejection and actually drive pressure to 93.6%. |
| slow historian | HARNESS GAP: corrected configuration sends slow historian requests to the local mock provider. |
| todo synthesis | HARNESS GAP: direct tool exposure plus `_todowrite` recognition preserves exact synthetic IDs, payloads and replay bytes. |
| window overlay reload | PRODUCT BUG: configured host windows were mislabeled observed; OMP additionally needed a mock overlay cell and restart/resume reload. |

Detailed source citations and carrier differences are in
[`packages/pi-plugin/PARITY.md`](../pi-plugin/PARITY.md#35-omp-provider-attestation-prevents-whole-system-byte-parity).
No new assertion is waived except by the two explicit manifest host divergences.
