"""Summarize a drive.ts run's SQL write trace (run with PROBE_SQL_TRACE=1).

usage: sqlsum.py <run directory>
For each transform pass drive.ts replayed, prints the kind of pass, the context.db WAL frames
the whole pass appended, and per table the plugin's write statements: how many ran, how many
changed a row, the megabytes bound to them, and the WAL frames their autocommit runs appended.
"""
import json, sys, collections
run = sys.argv[1]
kinds, ctx = {}, {}
for line in open(f"{run}/passes.jsonl"):
    e = json.loads(line)
    if "index" in e:
        kinds[e["index"]] = e["kind"]
        ctx[e["index"]] = e.get("context", {}).get("frames")
rows = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0.0, 0]))
for line in open(f"{run}/sqltrace.jsonl"):
    e = json.loads(line)
    a = rows[e["pass"]][e["table"]]
    a[0] += 1; a[1] += e["param_bytes"]; a[2] += e["frames"]; a[3] += 1 if (e["changes"] or 0) > 0 else 0
print(f"{'pass':>4} {'kind':<15} {'ctx frames':>10}  table: statements/changed rows/bound MB/autocommit frames")
for p in sorted(k for k in rows if isinstance(k, int)):
    parts = "; ".join(f"{t}: {v[0]}/{v[3]}/{v[1]/1e6:.2f}/{v[2]:.0f}" for t, v in sorted(rows[p].items()) if v[1] > 2000 or v[2] >= 1)
    print(f"{p:>4} {kinds.get(p,'?'):<15} {str(ctx.get(p)):>10}  {parts}")
for p in [k for k in rows if not isinstance(k, int)]:
    print(p, {t: v for t, v in rows[p].items()})
