#!/usr/bin/env bash
# Coordinated restart window for changes that move the context.db and/or store.db
# fences. Run it by hand from a terminal after quitting every OpenCode (TUI and
# `opencode serve`) and Pi process:
#
#   bash scripts/restart-window.sh --sha <ck-mc source sha> --staged <staged ck-mc> \
#       --dists <prebuilt checkout> --context-fence <N> --store-fence <M> [--dry-run]
#
# --dists names a checkout whose packages/plugin/dist and packages/pi-plugin/dist
# were built at the target commit; its packages/plugin/src is also used to run the
# context.db migrations, so it must be that same commit.
#
# Order matters. ck-mc is stopped first, so nothing holds either store. context.db
# is migrated by the new plugin code before the new ck-mc starts, because ck-mc
# reads tables the newer context.db migrations create. The new ck-mc then migrates
# store.db on its first open during placement.
#
# On a failure before any migration commits, both stores are restored from the
# clone taken at the start and the old ck-mc is restarted; it is then safe to start
# the old hosts again. After a migration has committed, the migrated stores and the
# new code are the consistent pair, so nothing is restored: the script stops and
# says not to start the hosts. The last line says which case applies.
set -uo pipefail
umask 077

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}"
SHA="" STAGED="" DISTS="" CONTEXT_FENCE="" STORE_FENCE="" DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --sha) SHA="$2"; shift 2 ;;
        --staged) STAGED="$2"; shift 2 ;;
        --dists) DISTS="$2"; shift 2 ;;
        --context-fence) CONTEXT_FENCE="$2"; shift 2 ;;
        --store-fence) STORE_FENCE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
for v in SHA STAGED DISTS CONTEXT_FENCE STORE_FENCE; do
    [ -n "${!v}" ] || { echo "missing --$(echo "$v" | tr 'A-Z_' 'a-z-')" >&2; exit 2; }
done

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK="$DATA/backups/restart-window-$STAMP"
STATUS="$DATA/backups/restart-window.status"
SENTINELS=(com.cortexkit.magic-context.cache-bust-sentinel com.cortexkit.magic-context.subagent-failure-sentinel com.cortexkit.magic-context.transform-latency-sentinel)

say() { echo "[$(date -u +%T)] $*"; }
notify() { echo; echo "==> $1"; }
status() { [ "$DRY_RUN" -eq 1 ] || echo "$1 $(date -u +%FT%TZ) $BK" > "$STATUS"; }
holders() { lsof "$DATA/context.db" "$DATA/context.db-wal" "$DATA/store.db" "$DATA/store.db-wal" 2>/dev/null | awk 'NR>1{print $1"/"$2}' | sort -u; }
# A read-only open of a cleanly closed WAL database (no -wal file) fails with
# SQLITE_CANTOPEN, so such a file is opened immutable instead. Every reader here
# runs with the hosts and ck-mc stopped, so nothing changes it underneath.
ro_uri() { if [ -e "$1-wal" ]; then echo "file:$1?mode=ro"; else echo "file:$1?immutable=1"; fi; }
context_version() { sqlite3 "$(ro_uri "$DATA/context.db")" 'SELECT MAX(version) FROM schema_migrations'; }
store_versions() { sqlite3 "$(ro_uri "$DATA/store.db")" 'SELECT namespace||":"||MAX(version) FROM cortexkit_schema_version GROUP BY namespace' | tr '\n' ' '; }
sentinels_back() {
    for s in "${SENTINELS[@]}"; do
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$s.plist" 2>/dev/null || true
    done
}
restore_and_fail() {
    say "FAIL: $1"
    if [ -f "$BK/pre/context.db" ]; then
        say "restoring the pre-window stores from $BK/pre"
        rm -f "$DATA"/context.db-wal "$DATA"/context.db-shm "$DATA"/store.db-wal "$DATA"/store.db-shm
        cp -c "$BK/pre/context.db" "$BK/pre/store.db" "$DATA/"
    fi
    ck module start magic-context || true
    sentinels_back
    status FAILED
    notify "FAILED: $1. Stores restored, old ck-mc restarted. Safe to start the old hosts."
    exit 1
}
post_fail() {
    say "FAIL after migration: $1"
    sentinels_back
    status POST_MIGRATION_FAILED
    notify "Migrated, but: $1. Do NOT start OpenCode or Pi yet."
    exit 3
}

# Preflight: everything the window needs exists and is the right build. Nothing
# is touched before these pass.
for pkg in plugin pi-plugin; do
    grep -lqE "LATEST_SUPPORTED_VERSION = ${CONTEXT_FENCE}([^0-9]|$)" "$DISTS/packages/$pkg/dist"/*.js 2>/dev/null \
        || { echo "prebuilt $pkg dist under $DISTS is not fence $CONTEXT_FENCE" >&2; exit 2; }
done
[ "$(git -C "$DISTS" rev-parse HEAD)" = "$(git -C "$DISTS" rev-parse "$SHA^{commit}" 2>/dev/null)" ] \
    || { echo "$DISTS is not checked out at $SHA" >&2; exit 2; }
[ -z "$(git -C "$DISTS" status --porcelain --untracked-files=no)" ] || { echo "$DISTS has uncommitted changes" >&2; exit 2; }
[ -x "$STAGED" ] || { echo "staged ck-mc missing: $STAGED" >&2; exit 2; }
# Capture first, then match: under pipefail, `cmd | grep -q` fails whenever grep
# exits on its match before cmd finishes writing (cmd gets SIGPIPE).
sig=$(codesign -d --verbose=2 "$STAGED" 2>&1)
[[ "$sig" == *"flags="*"runtime"* ]] || { echo "staged ck-mc is not signed with hardened runtime" >&2; exit 2; }
ver=$("$STAGED" --version 2>/dev/null)
[[ "$ver" == *"$SHA"* ]] || { echo "staged ck-mc --version does not report $SHA" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }

others=$(holders | grep -v '^ck-mc/' || true)
if [ -n "$others" ]; then
    echo "These processes still have the stores open. Quit them (OpenCode TUI, opencode serve, Pi) and run again. Nothing changed."
    for h in $others; do ps -o pid=,command= -p "${h#*/}" 2>/dev/null | cut -c1-120; done
    exit 2
fi
[ -n "$(context_version)" ] || { echo "cannot read the context.db schema version" >&2; exit 2; }
[ -n "$(store_versions)" ] || { echo "cannot read the store.db schema versions" >&2; exit 2; }
say "preflight ok: context.db $(context_version) -> $CONTEXT_FENCE, store.db $(store_versions)-> $STORE_FENCE, ck-mc $SHA"
if [ "$DRY_RUN" -eq 1 ]; then
    notify "Dry run: preflight passed. Nothing changed."
    exit 0
fi

mkdir -p "$BK"
exec > >(tee -a "$BK/window.log") 2>&1
status RUNNING
say "OpenCode and Pi are closed. Keep them closed until this finishes."

for s in "${SENTINELS[@]}"; do launchctl bootout "gui/$(id -u)/$s" 2>/dev/null || true; done
say "stopping ck-mc"
ck module stop magic-context || true
for _ in $(seq 1 60); do [ -z "$(holders)" ] && break; sleep 1; done
[ -z "$(holders)" ] || restore_and_fail "a store is still held after stopping ck-mc: $(holders | tr '\n' ' ')"

say "schema before: context=$(context_version) store=$(store_versions)"
sqlite3 "$DATA/context.db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || restore_and_fail "context.db checkpoint"
sqlite3 "$DATA/store.db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || restore_and_fail "store.db checkpoint"
mkdir -p "$BK/pre"
cp -c "$DATA/context.db" "$DATA/store.db" "$BK/pre/" || restore_and_fail "pre-window clone"
say "pre-window clone of both stores: $BK/pre"

# A store still at 92 runs migrations 93 and 94 here in one open; on a clone of
# the live store that took about 95 s under load, mostly moving LKG slots.
say "migrating context.db to $CONTEXT_FENCE with the new plugin code (can take a few minutes)"
(cd "$DISTS/packages/plugin" && MAGIC_CONTEXT_STORAGE_DIR="$DATA" bun -e "
const { openDatabase, getDatabasePersistenceError } = await import('./src/features/magic-context/storage-db.ts');
const db = openDatabase();
const error = getDatabasePersistenceError(db);
if (!db || error) { console.error('open failed:', error); process.exit(1); }
console.log('context.db open ok');
db.close();
") || restore_and_fail "context.db migration"
got=$(context_version)
[ "$got" = "$CONTEXT_FENCE" ] || restore_and_fail "context.db is at $got after migrating, expected $CONTEXT_FENCE"
say "context.db now $got"

say "swapping in the fence-$CONTEXT_FENCE plugin dists from $DISTS"
for pkg in plugin pi-plugin; do
    # A host that escaped the restart window can still import its old lazy
    # chunks. Merge the new build; only the shared age-based cleaner may prune
    # chunks, including the separately built OpenCode 2 distribution.
    # Prune before copying, just as a local build does. A prebuilt checkout can
    # have old mtimes even on chunks referenced by its current entry points.
    bun "$REPO/scripts/clean-dist-chunks.mjs" "$REPO/packages/$pkg/dist" || post_fail "dist cleanup for $pkg"
    bun "$REPO/scripts/clean-dist-chunks.mjs" "$REPO/packages/$pkg/dist/v2" || post_fail "v2 dist cleanup for $pkg"
    rsync -a "$DISTS/packages/$pkg/dist/" "$REPO/packages/$pkg/dist/" || post_fail "dist swap for $pkg"
done
(cd "$REPO" && bun -e "await import('./packages/plugin/dist/index.js'); await import('./packages/pi-plugin/dist/index.js'); console.log('dists load ok')") \
    || post_fail "the swapped dists do not load"

say "placing ck-mc $SHA (its first open migrates store.db to $STORE_FENCE)"
ck module start magic-context || true
# store.db 62->63 runs on the module's first open (8-32 s on clones under load),
# so give placement's version and health waits more headroom than the default.
PLACE_CK_MC_POLL_SECONDS=5 bash "$REPO/scripts/place-ck-mc.sh" --source-ref "$SHA" "$STAGED"
rc=$?
[ "$rc" -eq 0 ] || post_fail "ck-mc placement exited $rc"
got=$(store_versions)
[[ "$got" =~ :${STORE_FENCE}([^0-9]|$) ]] || post_fail "store.db is at $got after placement, expected $STORE_FENCE"
say "schema after: context=$(context_version) store=$got"

sentinels_back
status DONE
notify "Done. Start the OpenCode TUI (opencode) and ask MC to run the post-window check. If it passes, quit the TUI and start the fleet with opencode serve."
