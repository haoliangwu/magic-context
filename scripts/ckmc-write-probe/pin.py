"""Hold a read snapshot on each database so no checkpoint can reset its WAL.

With the WAL never reset, every frame a measured pass appends stays in the file, and
walattr.py can attribute all of them. Writes $PROBE_RUN/pin.ready once the snapshots are held.
"""
import os, sqlite3, sys, time
conns = []
for path in sys.argv[1:]:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("BEGIN")
    conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    conns.append(conn)
open(os.path.join(os.environ["PROBE_RUN"], "pin.ready"), "w").write(str(os.getpid()))
while True:
    time.sleep(3600)
