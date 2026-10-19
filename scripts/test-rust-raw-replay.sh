#!/usr/bin/env bash
# Offline host/module/provider-byte regressions; no daemon or live store is used.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [[ -n ${MC_RAW_REPLAY_BASELINE_ARCHIVE:-} ]]; then
    mkdir "$scratch/base"
    tar -xf "$MC_RAW_REPLAY_BASELINE_ARCHIVE" -C "$scratch/base"
    ln -s "$PWD/node_modules" "$scratch/base/node_modules"
    ln -s "$PWD/packages/plugin/node_modules" "$scratch/base/packages/plugin/node_modules"
    cp crates/mc-module/src/transform.rs "$scratch/current-transform.rs"
    restore() { cp "$scratch/current-transform.rs" crates/mc-module/src/transform.rs; touch crates/mc-module/src/transform.rs; }
    trap 'restore; rm -rf "$scratch"' EXIT
    cp "$scratch/base/crates/mc-module/src/transform.rs" crates/mc-module/src/transform.rs
    if [[ ${MC_RAW_REPLAY_BASELINE_RELEASE:-0} == 1 ]]; then
        cargo build --release -p mc-module --example transform_replay
        baseline_probe="${CARGO_TARGET_DIR:-target}/release/examples/transform_replay"
    else
        cargo build -p mc-module --example transform_replay
        baseline_probe="${CARGO_TARGET_DIR:-target}/debug/examples/transform_replay"
    fi
    cp "$baseline_probe" "$scratch/baseline-probe"
    restore
    trap 'rm -rf "$scratch"' EXIT
    export MC_RAW_REPLAY_BASELINE="$scratch/baseline-probe"
    export MC_RAW_REPLAY_BASELINE_ADAPTER="$scratch/base/packages/plugin/src/hooks/magic-context/rust-mode-transform.ts"
    export MC_REVIEW_BASELINE_ROOT="$scratch/base"
else
    echo "Master differential skipped: set MC_RAW_REPLAY_BASELINE_ARCHIVE to an offline git archive of the baseline sources."
fi

if [[ -n ${MC_RAW_REPLAY_PROBE:-} ]]; then
    if [[ ! -x "$MC_RAW_REPLAY_PROBE" ]]; then
        echo "Required staged MC_RAW_REPLAY_PROBE is not executable: $MC_RAW_REPLAY_PROBE" >&2
        exit 1
    fi
    printf 'Using staged Rust raw replay driver: %s\n' "$MC_RAW_REPLAY_PROBE"
else
    cargo build -p mc-module --example transform_replay
    # Stage executables outside target, including on removable storage.
    cp "${CARGO_TARGET_DIR:-target}/debug/examples/transform_replay" "$scratch/current-probe"
    export MC_RAW_REPLAY_PROBE="$scratch/current-probe"
fi
bun --version
cargo --version
rustc --version
BUN_JSC_useOMGJIT=0 bun test --timeout 120000 \
    packages/plugin/src/hooks/magic-context/rust-mode*.test.ts \
    packages/plugin/src/hooks/magic-context/rust-served-raw.test.ts \
    packages/plugin/src/plugin/messages-transform.test.ts \
    packages/plugin/src/features/magic-context/transform-decision-log.test.ts \
    packages/plugin/scripts/cache-bust-scheduler-log.test.ts \
    packages/plugin/scripts/cache-bust-sentinel.test.ts "$@"
