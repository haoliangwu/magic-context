"""Bytes per column of the plugin's session_meta and lkg_slots rows, from a clone of context.db.

usage: pluginrows.py <context.db clone> <session id prefix> [...]
One write of a row rewrites all of its bytes whenever the write changes the row's length, so
the row total is what each such write costs. Columns over 1,000 bytes are listed largest first.
Opened read-only; still, only ever pass an APFS clone.
"""
import json, sqlite3, sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
for table in ("session_meta", "lkg_slots"):
    cols = [r[1] for r in db.execute(f"pragma table_info({table})")]
    exprs = ", ".join('length("%s")' % c for c in cols)
    for prefix in sys.argv[2:]:
        row = db.execute(f"select session_id, {exprs} from {table} where session_id like ?", (prefix + "%",)).fetchone()
        if not row:
            print(table, prefix, "no row")
            continue
        sizes = {c: v for c, v in zip(cols, row[1:]) if v and v > 1000}
        total = sum(v or 0 for v in row[1:])
        print(table, row[0], "total", total, "columns", len(cols),
              "large", json.dumps(dict(sorted(sizes.items(), key=lambda kv: -kv[1]))))
