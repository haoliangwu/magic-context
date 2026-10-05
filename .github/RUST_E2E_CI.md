# Rust hermetic E2E CI gates

The Rust hermetic E2E gate exercises the production-shaped path:

```text
opencode serve → Magic Context plugin → ck-subc → ckdev-mc-e2e
```

[`scripts/run-rust-hermetic-e2e.sh`](../scripts/run-rust-hermetic-e2e.sh) is the
single invocation for local runs and CI. It derives test files from
`packages/e2e-tests/mode-manifest.json`, verifies the Rust source workspaces,
builds the current `ck-subc` and `ckdev-mc-e2e` pair, and requires a positive
Bun pass summary. Missing prerequisites, crashes, and zero-test runs fail.

## Hosted CI

Both `ci.yml` and `release.yml` check out the public
`cortexkit/commons` and `cortexkit/subconscious` repositories at their default-
branch heads. They place those checkouts under `.siblings/` and link them as
`../commons` and `../subconscious`, as required by Cargo path dependencies.
The workflows record both sibling commit SHAs in the job summary so the exact
source revisions used for each run are visible.

On each push covered by `ci.yml`, `Rust (crates)` runs formatting, Clippy, and
workspace tests. The hermetic Rust lane builds its binaries once and runs four
manifest-selected test shards. A nightly schedule continues to check the latest
sibling default-branch heads, and `workflow_dispatch` remains available.

The release workflow runs the Rust build and four shards for version tags.
`RELEASE_SKIP_RUST_E2E` can name one exact tag to skip the Rust jobs for that
release; `SKIP_RUST_E2E` is the corresponding local runner environment switch.
Without that exact tag match, publication requires the Rust build and all shards
to pass. No App credentials are used to fetch the public siblings.

Each build creates the binaries consumed by the shards and uploads them as a
short-lived workflow artifact. The hermetic Cargo target cache is keyed from
the repository Cargo lockfile, sibling Cargo inputs, runner OS, and
architecture. The shared script performs the authoritative harness builds and
runs the suite.

## First hosted-run check

Inspect the **E2E (Rust hermetic build)** summary. It includes a line of this
shape, with both checked-out sibling revisions:

```text
Rust hermetic sibling checkouts: commons=<sha>; subconscious=<sha>
```

Confirm the four test shards pass. The build summary and shard results make the
source revisions and test outcome independently visible.

## Runner notes

Ubuntu is the hosted OS for this stack. The harness uses portable Unix
facilities (process spawning, signals, XDG directories, and daemon sockets) and
does not require macOS. The cache is limited to the Rust hermetic Cargo target
output; source checkout and test failures remain visible as job failures.
