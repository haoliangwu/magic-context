#!/usr/bin/env bash
set -euo pipefail
bun --version
export BUN_JSC_useOMGJIT=0
mkdir -p "$TMPDIR/magic-context/oc2-render-review"
ROOT=$(mktemp -d "$TMPDIR/magic-context/oc2-render-review/sources-XXXXXX")
ISO=$(mktemp -d "$TMPDIR/magic-context/oc2-render-review/defaults-XXXXXX")
mkdir -p "$ROOT/baseline"
tar -xf .oc2-render-review-baseline.tar -C "$ROOT/baseline"
for dir in node_modules packages/*/node_modules; do
    [ ! -e "$PWD/$dir" ] || ln -s "$PWD/$dir" "$ROOT/baseline/$dir"
done
TEST=packages/pi-plugin/src/oc2-render-review.compat.test.ts
cp "$TEST" "$ROOT/baseline/$TEST"
mkdir -p "$ISO/home" "$ISO/config" "$ISO/data" "$ISO/cache" "$ISO/state" "$ISO/memory"
export HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data" XDG_CACHE_HOME="$ISO/cache" XDG_STATE_HOME="$ISO/state" MAGIC_CONTEXT_STORAGE_DIR="$ISO/memory" MAGIC_CONTEXT_LOG_PATH="$ISO/review.log" OPENCODE_DB="$ISO/host.db"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp" MAGIC_CONTEXT_TEST_DATA_DIR="$ISO/data"
export RENDER_REVIEW_ROOT="$ISO"
for host in oc1 pi; do
    rm -f "$ISO"/default-*.db* "$ISO"/pi-default-*.db*
    unset RENDER_REVIEW_EXPECT
    export RENDER_REVIEW_HOST="$host" RENDER_REVIEW_OUTPUT="$ROOT/baseline-$host.json"
    (cd "$ROOT/baseline" && bun test "$TEST")
    rm -f "$ISO"/default-*.db* "$ISO"/pi-default-*.db*
    export RENDER_REVIEW_EXPECT="$ROOT/baseline-$host.json" RENDER_REVIEW_OUTPUT="$ROOT/current-$host.json"
    bun test "$TEST"
done
unset RENDER_REVIEW_HOST RENDER_REVIEW_EXPECT
unset OPENCODE_DB

HOOK=packages/plugin/src/v2/hooks/issue-709-review.test.ts
FIT=packages/plugin/src/hooks/magic-context/historian-prompt-fit.test.ts
cp "$HOOK" "$ROOT/baseline/$HOOK"
cp "$FIT" "$ROOT/baseline/$FIT"
for mode in unfolded folded; do
    unset REVIEW709_RESTART_PHASE RENDER_REVIEW_UPGRADE_NO_FOLD
    [ "$mode" != unfolded ] || export RENDER_REVIEW_UPGRADE_NO_FOLD=1
    export REVIEW709_RESTART_ROOT="$ISO/upgrade-$mode" RENDER_REVIEW_UPGRADE_PHASE=write
    mkdir -p "$REVIEW709_RESTART_ROOT"
    (cd "$ROOT/baseline" && bun test "$HOOK" --timeout 60000 --test-name-pattern 'render review: memory-off upgrade')
    export RENDER_REVIEW_UPGRADE_PHASE=read REVIEW709_RESTART_PHASE=read
    bun test "$HOOK" --timeout 60000 --test-name-pattern 'render review: memory-off upgrade'
done
unset RENDER_REVIEW_UPGRADE_PHASE REVIEW709_RESTART_PHASE REVIEW709_RESTART_ROOT RENDER_REVIEW_UPGRADE_NO_FOLD

set +e
(cd "$ROOT/baseline" && bun test "$HOOK" "$FIT" --timeout 60000 --test-name-pattern 'render review: (first compaction|memory-off historian)') > "$ROOT/witnesses.log" 2>&1
baseline_witness_status=$?
set -e
printf 'BASELINE_WITNESS_EXIT=%s (expected 1; both findings must reproduce)\n' "$baseline_witness_status"
test "$baseline_witness_status" -eq 1
bun -e '
const output = await Bun.file(process.argv[1]).text();
console.log(output);
const failures = output.split("\n").filter(line => line.startsWith("(fail) "));
const expected = ["fitHistorianPrompt > render review: memory-off historian request must not contain project memories", "render review: first compaction before context initializes durable storage"];
if (failures.length !== 2 || expected.some(name => !failures.some(line => line.startsWith(`(fail) ${name} [`)))) throw new Error("baseline did not reproduce exactly the two named witnesses");
console.log("BASELINE_WITNESSES exactly 2 named failures; no other test failed");
' "$ROOT/witnesses.log"

PI_BOUNDARY=packages/pi-plugin/src/oc2-render-review-boundary.test.ts
SHARED_TRIM=packages/plugin/src/hooks/magic-context/inject-compartments.test.ts
cp "$PI_BOUNDARY" "$ROOT/baseline/$PI_BOUNDARY"
cp "$SHARED_TRIM" "$ROOT/baseline/$SHARED_TRIM"
(cd "$ROOT/baseline" && bun test "$PI_BOUNDARY" "$SHARED_TRIM" --timeout 60000 --test-name-pattern 'render review: (Pi omitted boundary|shipped trim)')
set +e
bun test "$PI_BOUNDARY" "$SHARED_TRIM" --timeout 60000 --test-name-pattern 'render review: (Pi omitted boundary|shipped trim)' > "$ROOT/trim-regressions.log" 2>&1
trim_status=$?
set -e
test "$trim_status" -eq 1
bun -e '
const output = await Bun.file(process.argv[1]).text();
console.log(output);
const failures = output.split("\n").filter(line => line.startsWith("(fail) "));
const expected = ["render review: Pi omitted boundary preserves cached-prefix replay bytes", "prepared prefix source-order trimming > render review: shipped trim retains instruction bytes before a visible boundary"];
if (failures.length !== 2 || expected.some(name => !failures.some(line => line.startsWith(`(fail) ${name} [`)))) throw new Error("candidate did not expose exactly the two shipped trim contract differences");
console.log("TRIM_REGRESSIONS shipped=2 passed; candidate=2 named failures; no other failure");
' "$ROOT/trim-regressions.log"
