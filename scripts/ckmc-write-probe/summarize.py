"""Summarize passes.jsonl: per pass kind, module bytes written, store/context WAL bytes, commits."""
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
agg = collections.defaultdict(list)
for e in rows:
    if "store" not in e or e.get("kind") in ("run_total_context_db",):
        continue
    s, c = e["store"], e["context"]
    agg[e["kind"]].append((e["module_bytes_written"], s.get("wal_bytes", 0), s.get("commits", 0), c.get("wal_bytes", 0), e["row"]["row_version"]))
    print(f"{e['kind']:15} module_written={e['module_bytes_written']:>10} store_wal={s.get('wal_bytes',0):>10} store_txns={s.get('commits',0):>3} context_wal={c.get('wal_bytes',0):>9} row_version={e['row']['row_version']} core={e['row']['core']} meta={e['row']['meta']} trace={e['row']['pass_trace_bytes']}")
print()
for k, v in agg.items():
    n = len(v)
    print(f"{k:15} n={n} mean module_written={sum(x[0] for x in v)/n:>12.0f} mean store_wal={sum(x[1] for x in v)/n:>12.0f} mean store_txns={sum(x[2] for x in v)/n:.1f}")
