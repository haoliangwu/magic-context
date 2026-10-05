# GitHub issue #384 — subc consumer-identity isolation

Date: 2026-08-29

## Client contract verified at source

`@cortexkit/subc-client` 0.4.1 documents `RouteOpenOptions.consumerIdentity` as optional in `packages/plugin/node_modules/@cortexkit/subc-client/dist/client.d.ts:27-31`: when it is omitted, a non-empty `SUBC_MODULE_ID` plus `SUBC_LAUNCH_NONCE` supplies the route-open consumer identity. The implementation confirms the distinction in `dist/client.js:958-965`: only an explicit `consumerIdentity: null` prevents the environment fallback, and the route body includes `consumer_identity` whenever that derived identity is present.

## Call-site audit and resolution

| Call site | Context | Resolution |
|---|---|---|
| `packages/plugin/src/hooks/magic-context/module-transport.ts` | Plugin host under OpenCode | Its typed local route-open wrapper accepts `Omit<RouteOpenOptions, "consumerIdentity">` and pins `consumerIdentity: null`. |
| `packages/plugin/scripts/probe-subc-transport.ts` | Shell-run transport probe | Passes `consumerIdentity: null` directly. |
| `packages/e2e-tests/src/rust-runner/hermetic-subc.ts` | Hermetic test-host status client | Its typed local route-open wrapper accepts `Omit<RouteOpenOptions, "consumerIdentity">` and pins `consumerIdentity: null`. |

Each host/script call has a one-line explanation: inherited `SUBC_*` credentials identify a daemon-supervised module, not an independent host. The wrappers make an ordinary caller unable to reintroduce `consumerIdentity` through their options argument.

A repository-wide TypeScript route-open search found no other product calls. Rust's `crates/mc-module/src/historian_producer.rs:773-790` deliberately derives `consumer_identity` from `SUBC_MODULE_ID` and `SUBC_LAUNCH_NONCE`. That asymmetry is correct: `ck-mc` is the genuinely supervised module, so its own live supervisor identity is its identity; plugin hosts and independently launched scripts are not supervised modules and must never adopt an inherited one.

No collision fence moved.

## Regression and mutation evidence

`packages/plugin/src/hooks/magic-context/module-transport.test.ts` captures the actual `route.open` control-frame JSON with its fake subc peer. The regression sets `SUBC_MODULE_ID=other-supervised-module` and a 64-character `SUBC_LAUNCH_NONCE`, then asserts that the captured route-open body has no `consumer_identity`. This observes the wire body rather than an option proxy, so the fixture expresses the ambient-identity contrast directly.

Executed mutation evidence: the explicit `consumerIdentity: null` in `module-transport.ts` was deliberately removed and marked `NON-VACUITY BREAK`. The focused test failed at `module-transport.test.ts:211`, capturing the forbidden `consumer_identity` with module ID `other-supervised-module` and the 64-character nonce. The explicit null was restored immediately; no mutation marker remains in runnable source or tests.

## Draft reply for issue #384

Thanks, iceteaSA — this report correctly identified that omitting `consumerIdentity` opts in to `SUBC_MODULE_ID`/`SUBC_LAUNCH_NONCE` fallback rather than opting out. We verified that behavior in the published client declarations and implementation, then fixed all four audited magic-context host/script call sites.

The two internal host wrappers now accept `Omit<RouteOpenOptions, "consumerIdentity">` and pin `consumerIdentity: null`; the two direct scripts pass explicit null. The regression sets a fake supervised module ID plus a 64-character nonce and checks the captured `route.open` wire body has no `consumer_identity`. Removing the null makes that test fail with the injected identity, so it covers the inherited-environment failure mode rather than the unset-env happy path.

The Rust historian producer intentionally retains environment-derived identity because `ck-mc` is the supervised module in that direction. The host/script paths are intentionally different: an inherited supervisor identity is never theirs to use.

## Validation

- `bun test src/hooks/magic-context/module-transport.test.ts` — passed after restoration (23 tests); it also produced the deliberate red mutation above.
- `bun run test` in `packages/plugin` — passed (4,184 tests).
- `bun run build` — passed; it supplied the ignored plugin distributions required by the end-to-end suite.
- `bun run typecheck` — passed for the workspace TypeScript packages.
- `bun test src/rust-runner/hermetic-subc.test.ts` — passed (3 tests).
- Targeted `tsc` for `src/rust-runner/hermetic-subc.ts` — passed.
- Full `bun run test` in `packages/e2e-tests` was run after building distributions, but did not reach green because of five pre-existing, unrelated integration failures: `rust-fold-under-pressure`, `tag-owner-collision`, two `rust-historian-producer` tests, and `rust-ctx-reduce-roundtrip`. The failures exercise folding, socket/process timing, historian delivery, and pending-drop accounting rather than route-open consumer identity. The focused hermetic harness test remains green.
- Full plugin lint also has nine pre-existing failures outside this change; targeted Biome validation of the changed plugin files passed.

Credit to iceteaSA for the call-site audit, the explicit fix shape, and the load-bearing test framing, and to the Subconscious and Anthropic maintainers for finding and relaying the env-inheritance behavior. No GitHub action was taken from this worktree.
