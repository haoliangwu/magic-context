"""List each transaction in a WAL (frames, distinct pages) from frame <start> on, with the
owning b-tree of each page as mapped now. usage: walcommits.py <db> [start_frame]"""
import json, os, shutil, sqlite3, struct, subprocess, sys, tempfile
db = sys.argv[1]; start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
data = open(db + "-wal", "rb").read()
_, _, page_size, _, s1, s2, _, _ = struct.unpack(">8I", data[:32])
frames, off = [], 32
while off + 24 + page_size <= len(data):
    pgno, commit, a, b = struct.unpack(">4I", data[off:off + 16])
    if (a, b) != (s1, s2): break
    frames.append((pgno, commit)); off += 24 + page_size
tmp = tempfile.mkdtemp()
for sfx in ("", "-wal"):
    subprocess.run(["cp", "-c", db + sfx, os.path.join(tmp, "x.db" + sfx)], check=True)
owner = dict(sqlite3.connect(os.path.join(tmp, "x.db")).execute("select pageno, name from dbstat"))
shutil.rmtree(tmp)
txn = []
for i, (pgno, commit) in enumerate(frames):
    if i < start: continue
    txn.append(pgno)
    if commit:
        names = {}
        for p in txn: names[owner.get(p, "free")] = names.get(owner.get(p, "free"), 0) + 1
        print(i + 1, len(txn), json.dumps(dict(sorted(names.items(), key=lambda kv: -kv[1])[:5])))
        txn = []
