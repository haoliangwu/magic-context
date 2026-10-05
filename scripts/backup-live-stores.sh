#!/usr/bin/env bash
# Snapshot the live Magic Context and OpenCode stores to an external drive
# while sessions are still writing to them.
#
# Uses `VACUUM INTO`, which runs inside one read transaction, so each copy is a
# consistent point-in-time image even under concurrent WAL writers; it never
# takes a write lock on the live file. Each copy is integrity-checked
# (`PRAGMA quick_check`) and the schema version is recorded so a restore can
# be matched against the fence the plugin dists were built for.
#
# Usage: scripts/backup-live-stores.sh [dest-root]   (default /Volumes/UGREEN/mc-backups)
# Restore: stop every process holding the store, copy <snapshot>/<name>.db over
# the live path (remove the live -wal/-shm first), then start one seat.
# context.db and store.db are one consistency unit: restore both from the same
# snapshot, together with a ck-mc build that knows the recorded store.db version.
# ck-mc refuses to open a store.db newer than its own migrations.
set -euo pipefail

DEST_ROOT="${1:-/Volumes/UGREEN/mc-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DEST_ROOT/$STAMP"

MC_DIR="${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}"
OC_DIR="$HOME/.local/share/opencode"

declare -a SOURCES=(
    "$MC_DIR/context.db"
    "$MC_DIR/store.db"
    "$OC_DIR/opencode.db"
)

if [ ! -d "$DEST_ROOT" ]; then
    # Refuse to create the root: a missing external drive must not silently
    # turn into a backup on the boot volume.
    echo "backup root $DEST_ROOT does not exist (drive not mounted?)" >&2
    exit 2
fi
mkdir -p "$DEST"

need_bytes=0
for src in "${SOURCES[@]}"; do
    [ -f "$src" ] || { echo "missing live store: $src" >&2; exit 2; }
    need_bytes=$((need_bytes + $(stat -f %z "$src")))
done
free_bytes=$(( $(df -k "$DEST_ROOT" | awk 'NR==2 {print $4}') * 1024 ))
if [ "$free_bytes" -lt $((need_bytes + need_bytes / 10)) ]; then
    echo "insufficient space on $DEST_ROOT: need ~$((need_bytes / 1000000)) MB, have $((free_bytes / 1000000)) MB" >&2
    exit 2
fi

echo "snapshot -> $DEST"
for src in "${SOURCES[@]}"; do
    name="$(basename "$src")"
    out="$DEST/$name"
    start=$(date +%s)
    # mode=ro keeps this connection from ever writing to the live file; the
    # -wal/-shm sidecars are still read so uncheckpointed pages are included.
    sqlite3 "file:$src?mode=ro" "VACUUM INTO '$out';"
    check="$(sqlite3 "$out" 'PRAGMA quick_check;' | head -1)"
    if [ "$check" != "ok" ]; then
        echo "  $name: quick_check FAILED: $check" >&2
        exit 1
    fi
    # context.db and opencode.db record their version in schema_migrations; the Rust module's
    # store.db keeps its own chain in cortexkit_schema_version. Recording the store.db version
    # lets a restore be matched to a ck-mc build that knows it: a binary older than that
    # version refuses to open the store.
    if [ "$name" = "store.db" ]; then
        version_sql="SELECT MAX(version) FROM cortexkit_schema_version WHERE namespace = 'mc_cache';"
    else
        version_sql='SELECT MAX(version) FROM schema_migrations;'
    fi
    version="$(sqlite3 "$out" "$version_sql" 2>/dev/null || echo n/a)"
    size_mb=$(( $(stat -f %z "$out") / 1000000 ))
    echo "  $name: ${size_mb} MB, quick_check ok, schema_migrations max=${version}, $(( $(date +%s) - start ))s"
    printf '%s\t%s\tschema=%s\tsha256=%s\n' "$name" "$src" "$version" "$(shasum -a 256 "$out" | cut -d' ' -f1)" >> "$DEST/MANIFEST.tsv"
done

echo "done: $DEST"
cat "$DEST/MANIFEST.tsv"
