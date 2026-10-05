"""Attribute WAL frames appended since a mark to the b-tree (table/index) that owns each page.

usage: walattr.py <db_path> <start_frame> [--map]
Prints JSON: {frames, commits, end_frame, salt, by_table:{name:{frames,bytes,distinct_pages}}}
The page map comes from dbstat on an APFS clone of the db+wal taken at call time, so the
running writer is never disturbed. Frames are only counted while the WAL salt is unchanged;
the caller pins a reader so the WAL is never reset during a measurement.
"""
import json, os, shutil, sqlite3, struct, subprocess, sys, tempfile

db, start = sys.argv[1], int(sys.argv[2])
want_map = "--map" in sys.argv
wal = db + "-wal"
with open(wal, "rb") as f:
    data = f.read()
if len(data) < 32:
    print(json.dumps({"frames": 0, "commits": 0, "end_frame": 0, "by_table": {}}))
    sys.exit(0)
magic, ver, page_size, ckpt_seq, salt1, salt2, _, _ = struct.unpack(">8I", data[:32])
frame_size = 24 + page_size
frames = []
off = 32
while off + frame_size <= len(data):
    pgno, commit, s1, s2 = struct.unpack(">4I", data[off:off + 16])
    if (s1, s2) != (salt1, salt2):
        break
    frames.append((pgno, commit))
    off += frame_size
# Trim an uncommitted tail: only frames up to the last commit frame are durable.
last_commit = max((i for i, (_, c) in enumerate(frames) if c), default=-1)
frames = frames[: last_commit + 1]
new = frames[start:]
out = {"frames": len(new), "commits": sum(1 for _, c in new if c), "end_frame": len(frames),
       "salt": [salt1, salt2], "ckpt_seq": ckpt_seq, "page_size": page_size,
       "wal_bytes": len(new) * frame_size}
if want_map and new:
    tmp = tempfile.mkdtemp(prefix="walattr-")
    try:
        for suffix in ("", "-wal"):
            subprocess.run(["cp", "-c", db + suffix, os.path.join(tmp, "x.db" + suffix)], check=True)
        conn = sqlite3.connect(os.path.join(tmp, "x.db"))
        pages = set(p for p, _ in new)
        owner = {}
        for pageno, name in conn.execute("select pageno, name from dbstat"):
            if pageno in pages:
                owner[pageno] = name
        conn.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    by = {}
    for pgno, _ in new:
        name = owner.get(pgno, "page1" if pgno == 1 else "freelist/other")
        e = by.setdefault(name, {"frames": 0, "bytes": 0, "pages": set()})
        e["frames"] += 1
        e["bytes"] += frame_size
        e["pages"].add(pgno)
    out["by_table"] = {k: {"frames": v["frames"], "bytes": v["bytes"], "distinct_pages": len(v["pages"])}
                       for k, v in sorted(by.items(), key=lambda kv: -kv[1]["bytes"])}
    out["distinct_pages"] = len(set(p for p, _ in new))
print(json.dumps(out))
