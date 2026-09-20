#!/usr/bin/env bash
# Execute the hermetic Rust e2e group from the committed mode manifest.
#
# This is the single invocation used by the local release script and the release
# workflow. Keeping prerequisite checks, the manifest selection, and Bun's
# true-green summary check here prevents CI from silently testing a different
# subset than a local release.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

# The host and hermetic e2e lanes spawn `opencode serve` from PATH. The official
# installer puts the binary under ~/.opencode/bin, which login shells add to PATH but
# tool/daemon shells often do not (v0.42.6 r9: the same box that passed r8 lost the
# entry when the tool daemon restarted). Prefer the ambient PATH; fall back to the
# installer location before declaring it missing.
if ! command -v opencode >/dev/null 2>&1 && [ -x "$HOME/.opencode/bin/opencode" ]; then
  export PATH="$HOME/.opencode/bin:$PATH"
fi
E2E_DIR="$REPO_ROOT/packages/e2e-tests"
MANIFEST_VALIDATOR="$E2E_DIR/scripts/validate-mode-manifest.ts"
PREREQUISITE_DETECTOR="$E2E_DIR/scripts/check-rust-prerequisites.ts"

if [[ "$#" -ne 0 ]]; then
    echo "Usage: scripts/run-rust-hermetic-e2e.sh" >&2
    exit 2
fi

# Run one manifest file in a fresh Bun process. Prints the file's output and
# returns 0 only when the summary shows passing tests and no failures.
run_e2e_file() {
    local mode="$1" label="$2" file="$3" output file_status
    file_status=0
    output=$(cd "$E2E_DIR" && MC_E2E_MODE="$mode" NODE_ENV="" bun test --timeout 600000 --max-concurrency=1 "$file" 2>&1) || file_status=$?
    echo "$output"
    if echo "$output" | grep -qE "[1-9][0-9]* fail"; then
        echo "Error: e2e ($mode/$label) file $file failed (fail count > 0)" >&2
        return 1
    fi
    if ! echo "$output" | grep -qE "[1-9][0-9]* pass"; then
        echo "Error: e2e ($mode/$label) file $file produced no passing-test summary (crash, timeout, or zero tests collected)" >&2
        return 1
    fi
    if [[ "$file_status" -ne 0 ]]; then
        echo "  [e2e:$mode:$label:file] $file note: tests passed but Bun exited $file_status (known post-completion panic) — tolerated"
    fi
    return 0
}

run_e2e_group() {
    local mode="$1" label="$2" files="$3" file group_status
    echo "  [e2e:$mode:$label:start] bun test..."
    group_status=0

    # A Bun process can retain timers, child-process handlers, and inherited
    # process state after a suite finishes. Give every real daemon/module/OpenCode
    # stack a fresh parent process so one suite cannot starve a later restart.
    for file in $files; do
        echo "  [e2e:$mode:$label:file:start] $file"
        if run_e2e_file "$mode" "$label" "$file"; then
            echo "  [e2e:$mode:$label:file:end] $file status=pass"
            continue
        fi
        # Bounded per-file retry (budget 1), mirroring the release machine's
        # rerun_budget semantics: these suites boot real daemon/OpenCode stacks
        # whose fixed liveness ceilings lose the race under box load, and the
        # roaming single-file timeout is the dominant false-red in release runs.
        # A deterministic defect fails the fresh process too; the loud RETRY
        # lines keep recovered flakes visible in release logs instead of masked.
        echo "  [e2e:$mode:$label:file:RETRY] $file — first run failed; one fresh-process retry"
        if run_e2e_file "$mode" "$label" "$file"; then
            echo "  [e2e:$mode:$label:file:end] $file status=pass (RETRY-RECOVERED — load-class flake; investigate if this line recurs across releases)"
            continue
        fi
        echo "  [e2e:$mode:$label:file:end] $file status=fail (failed twice in fresh processes)"
        group_status=1
    done

    if [[ "$group_status" -ne 0 ]]; then
        echo "  [e2e:$mode:$label:end] status=fail"
        return 1
    fi
    echo "  [e2e:$mode:$label:end] status=pass"
}

echo "  [e2e:rust:prerequisites:start] resolving current Rust workspaces..."
# `--hermetic` verifies the two source workspaces without performing the obsolete
# root-target ck-mc build. HermeticSubcStack performs the one authoritative build
# into its e2e-owned target directory and renames that current-tree binary to
# ckdev-mc-e2e before spawning it.
if ! bun "$PREREQUISITE_DETECTOR" --hermetic; then
    echo "Error: Rust e2e prerequisite detector failed; the rust group is RED (never skipped)." >&2
    echo "  [e2e:rust:prerequisites:end] status=fail"
    exit 1
fi
if ! command -v opencode >/dev/null 2>&1; then
    echo "Error: 'opencode' not found on PATH — Rust e2e spawns 'opencode serve'." >&2
    echo "  [e2e:rust:prerequisites:end] status=fail"
    exit 1
fi
echo "  [e2e:rust:prerequisites:end] status=pass"

RUST_E2E_FILES=$(bun "$MANIFEST_VALIDATOR" --mode rust --harness all | tr '\n' ' ')
if [[ -z "$RUST_E2E_FILES" ]]; then
    echo "Error: Rust e2e manifest selected zero test files" >&2
    exit 1
fi

echo "Running Rust hermetic e2e tests from mode manifest: $RUST_E2E_FILES"
run_e2e_group "rust" "hermetic" "$RUST_E2E_FILES"
