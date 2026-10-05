# Rust hermetic E2E CI feasibility (2026-08-25)

## Decision

Run the Rust hermetic suite on GitHub-hosted Linux runners. The required source
workspaces are available from the public `cortexkit/commons` and
`cortexkit/subconscious` repositories, checked out beside Magic Context to satisfy
its Cargo path dependencies. The shared harness builds and tests the current
source pair; missing prerequisites, crashes, timeouts, and zero-test runs fail.
See [the CI runbook](../.github/RUST_E2E_CI.md) for the active workflow shape.

## Source findings

`packages/e2e-tests/src/rust-runner/hermetic-subc.ts` defines the executable
contract. `buildHermeticBinaries()` builds `mc-module` in this checkout and
`subc-core` in the sibling `subconscious` checkout, then runs the daemon and a
deterministic host harness. The required source is broader than the daemon
checkout: root `Cargo.toml` points `cortexkit-*` dependencies at `../commons` and
all `subc-*` dependencies at `../subconscious`.

The harness rejects Windows and otherwise uses portable Unix facilities. Linux
is therefore source-feasible. The test manifest and shared script validate test
selection and require a positive pass summary.

## Hosted workflow design

Both CI and release check out the public siblings, restore the isolated Rust
hermetic Cargo target cache, build the binaries once, and upload them as an
artifact consumed by the four test shards. CI runs Rust crate validation and the
hermetic shards on pushes, as well as a nightly scheduled run to check the latest
sibling default-branch heads. Release tags run the same build-and-shard shape;
the exact-tag `RELEASE_SKIP_RUST_E2E` operator setting remains available for a
release-specific skip. The release gate requires successful Rust build and shard
results unless that exact tag is explicitly skipped.

GitHub-hosted Linux is source-feasible. Planning estimates are 25–45 minutes
from a cold cache and 12–25 minutes from a warm cache; measure actual durations
before making a service-level claim.
