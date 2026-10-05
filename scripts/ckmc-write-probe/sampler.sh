#!/bin/bash
# sampler.sh [count] [interval]: clone the live store.db every <interval> seconds (APFS clone,
# never opened in place) and keep the cache rows active in the last 15 minutes, so that
# diffsamples.py can show which fields each commit actually changed.
set -euo pipefail
W=${CKMC_PROBE_DIR:-${TMPDIR%/}/magic-context/ckmc-writes}/samples
LIVE=${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}
COUNT=${1:-24}; INTERVAL=${2:-10}
mkdir -p "$W"
for i in $(seq -w 1 "$COUNT"); do
    rm -rf "$W/tmp"; mkdir -p "$W/tmp"
    cp -c "$LIVE/store.db" "$LIVE/store.db-wal" "$W/tmp/"
    python3 - "$W/tmp/store.db" "$W/s$i.json" <<'PY'
import json, sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
rows = db.execute("select session_id, row_version, core_state, meta from mc_cache_state "
                  "where last_activity_at > (strftime('%s','now') - 900) * 1000").fetchall()
trace = db.execute("select session_id, length(scheduler_history), length(scheduler_interesting_history), "
                   "length(coalesce(first_divergence,'')), length(coalesce(last_divergence,'')) from mc_pass_trace").fetchall()
json.dump({"t": time.time(), "rows": rows, "pass_trace": trace}, open(sys.argv[2], "w"))
PY
    rm -rf "$W/tmp"
    sleep "$INTERVAL"
done
