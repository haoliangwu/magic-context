#!/usr/bin/env python3
"""Build a small OpenCode database from the scrubbed full copy, keeping chosen sessions.

The migration engine never reads opencode.db. The rehearsal needs OpenCode's database
only for host drives, which create their own sessions, and for spot checks that expand
the raw history of specific real sessions. When the disk cannot hold a VACUUMed copy of
the full database, this writes a fresh database with the same schema that holds:

* every row of the non-session tables, except the credential tables, which stay empty;
* for session-keyed tables, only rows of the named sessions;
* for the event log, only events whose aggregate is one of the named sessions.

Because the output is written row by row into a new file, no deleted credential row can
survive in its free pages.

Usage:
    python3 scripts/b2-drill/subset-opencode.py <full-copy.db> <out.db> <session-id>...
Both paths must be under $TMPDIR/magic-context/.
"""

import os
import sqlite3
import sys
import time

CREDENTIAL_TABLES = {"credential", "account", "account_state", "control_account"}


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    source, out, sessions = sys.argv[1], sys.argv[2], sys.argv[3:]
    allowed = os.path.realpath(os.path.join(os.environ.get("TMPDIR", "/tmp"), "magic-context"))
    for path in (source, out):
        if not os.path.realpath(os.path.dirname(os.path.abspath(path))).startswith(allowed + os.sep):
            print(f"refusing path outside {allowed}: {path}", file=sys.stderr)
            return 2
    if os.path.exists(out):
        print(f"refusing to overwrite {out}", file=sys.stderr)
        return 2
    started = time.time()
    db = sqlite3.connect(out)
    db.execute("ATTACH DATABASE ? AS src", (source,))
    objects = db.execute(
        "SELECT type, name, sql FROM src.sqlite_master "
        "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
    ).fetchall()
    for kind, name, sql in objects:
        if kind == "table":
            db.execute(sql)
    marks = ",".join("?" for _ in sessions)
    copied = {}
    for kind, name, _ in objects:
        if kind != "table":
            continue
        columns = [row[1] for row in db.execute(f'PRAGMA src.table_info("{name}")')]
        if name in CREDENTIAL_TABLES:
            where, args = "0", []
        elif name == "session":
            where, args = f"id IN ({marks})", sessions
        elif "session_id" in columns:
            where, args = f"session_id IN ({marks})", sessions
        elif "aggregate_id" in columns:
            where, args = f"aggregate_id IN ({marks})", sessions
        else:
            where, args = "1", []
        cursor = db.execute(f'INSERT INTO main."{name}" SELECT * FROM src."{name}" WHERE {where}', args)
        copied[name] = cursor.rowcount
    for kind, name, sql in objects:
        if kind in ("index", "trigger", "view"):
            db.execute(sql)
    db.commit()
    db.execute("DETACH DATABASE src")
    credential_rows = {
        table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        for table in CREDENTIAL_TABLES
        if table in copied
    }
    check = db.execute("PRAGMA quick_check").fetchone()[0]
    db.close()
    print(
        {
            "seconds": round(time.time() - started, 1),
            "bytes": os.path.getsize(out),
            "rows": copied,
            "credential_rows": credential_rows,
            "quick_check": check,
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
