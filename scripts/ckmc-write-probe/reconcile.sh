#!/bin/bash
# reconcile.sh <ck-mc pid> [seconds]
# Read the running ck-mc's disk-write counter at both ends of a window and count the cache
# commits in between from two APFS clones of store.db (the live file is never opened).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=${CKMC_PROBE_DIR:-${TMPDIR%/}/magic-context/ckmc-writes}/reconcile
LIVE=${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}
P=${1:?ck-mc pid required}; S=${2:-180}
mkdir -p "$W"
snap() { rm -rf "$W/$1"; mkdir -p "$W/$1"; cp -c "$LIVE/store.db" "$LIVE/store.db-wal" "$W/$1/"; }
python3 "$HERE/rusage.py" "$P" > "$W/w0.json"; date +%s > "$W/t0"; snap a
sleep "$S"
python3 "$HERE/rusage.py" "$P" > "$W/w1.json"; date +%s > "$W/t1"; snap b
python3 - "$W" <<'PY'
import json, sqlite3, sys
w = sys.argv[1]
w0 = list(json.load(open(f"{w}/w0.json")).values())[0]["written"]
w1 = list(json.load(open(f"{w}/w1.json")).values())[0]["written"]
t0, t1 = int(open(f"{w}/t0").read()), int(open(f"{w}/t1").read())
def rows(path):
    return {r[0]: (r[1], r[2]) for r in sqlite3.connect(path).execute(
        "select session_id, row_version, length(core_state) + length(meta) from mc_cache_state")}
a, b = rows(f"{w}/a/store.db"), rows(f"{w}/b/store.db")
commits = [(s, v - a.get(s, (0, 0))[0], size) for s, (v, size) in b.items() if v != a.get(s, (0, 0))[0]]
total = sum(n for _, n, _ in commits)
print(json.dumps({
    "seconds": t1 - t0, "written": w1 - w0, "commits": total,
    "commits_on_rows_over_1MB": sum(n for _, n, size in commits if size > 1_000_000),
    "sum_commits_x_row_bytes": sum(n * size for _, n, size in commits),
    "written_per_commit": (w1 - w0) / max(total, 1),
    "sessions": sorted(((s[:20], n, size) for s, n, size in commits), key=lambda x: -x[2])[:10],
}))
PY
