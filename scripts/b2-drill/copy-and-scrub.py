#!/usr/bin/env python3
"""Copy the live Magic Context and OpenCode stores into a throwaway drill root.

This is the only step of the single-store rehearsal that touches the live files, and it
only reads them:

* each source is opened through a ``file:...?mode=ro`` URI with ``PRAGMA query_only=ON``;
* SQLite's online backup API copies a consistent image, including committed WAL pages,
  while live hosts keep writing;
* nothing else ever opens a live path. Every later step (doctor, hosts, drivers) works on
  the copies under the destination root.

The OpenCode copy then loses its credential tables (``credential``, ``account``,
``account_state``, ``control_account``) and is VACUUMed, so no secret survives in the
drill root, including in free pages.

Usage:
    python3 scripts/b2-drill/copy-and-scrub.py <dest-root>

The destination must be under $TMPDIR/magic-context/ and must not already hold copies.
Writes <dest-root>/snapshot/{opencode.db,context.db,store.db} and a JSON manifest with
timings, quick_check results, SHA-256 digests and the scrubbed table counts.
"""

import hashlib
import json
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
# context.db and store.db form one consistency unit, so they are copied first and
# back to back; the large OpenCode copy follows.
LIVE = {
    "context.db": os.path.join(HOME, ".local/share/cortexkit/magic-context/context.db"),
    "store.db": os.path.join(HOME, ".local/share/cortexkit/magic-context/store.db"),
    "opencode.db": os.path.join(HOME, ".local/share/opencode/opencode.db"),
}
CREDENTIAL_TABLES = ("credential", "account", "account_state", "control_account")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_read_only(source, destination):
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        src.execute("PRAGMA query_only=ON")
        dst = sqlite3.connect(destination)
        try:
            # One step copies the whole file inside a single read transaction. A stepped
            # backup restarts from scratch whenever a live writer commits between steps,
            # and on a busy store it never finishes. A WAL reader does not block writers.
            src.backup(dst, pages=-1)
        finally:
            dst.close()
    finally:
        src.close()


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = os.path.realpath(sys.argv[1])
    allowed = os.path.realpath(os.path.join(os.environ.get("TMPDIR", "/tmp"), "magic-context"))
    if not root.startswith(allowed + os.sep):
        print(f"refusing destination outside {allowed}: {root}", file=sys.stderr)
        return 2
    snapshot = os.path.join(root, "snapshot")
    os.makedirs(snapshot, exist_ok=True)
    manifest = {"started_at": time.time(), "files": {}}
    for name, source in LIVE.items():
        destination = os.path.join(snapshot, name)
        if os.path.exists(destination):
            print(f"refusing to overwrite existing copy {destination}", file=sys.stderr)
            return 2
        entry = {"source": source}
        started = time.time()
        copy_read_only(source, destination)
        entry["copy_seconds"] = round(time.time() - started, 1)
        db = sqlite3.connect(destination)
        try:
            if name == "opencode.db":
                started = time.time()
                present = {
                    row[0]
                    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                for table in CREDENTIAL_TABLES:
                    if table in present:
                        db.execute(f'DELETE FROM "{table}"')
                db.commit()
                db.execute("VACUUM")
                entry["scrub_vacuum_seconds"] = round(time.time() - started, 1)
                entry["credential_counts"] = {
                    table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                    for table in CREDENTIAL_TABLES
                    if table in present
                }
            started = time.time()
            entry["quick_check"] = db.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            db.close()
        entry["sha256"] = sha256(destination)
        entry["check_hash_seconds"] = round(time.time() - started, 1)
        entry["bytes"] = os.path.getsize(destination)
        manifest["files"][name] = entry
        print(json.dumps({name: entry}), flush=True)
    manifest["finished_at"] = time.time()
    with open(os.path.join(root, "snapshot-manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
