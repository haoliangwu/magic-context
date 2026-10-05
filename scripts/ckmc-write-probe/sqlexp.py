"""Replay the storage half of a transform commit at SQL level on a clone of store.db.

The statements are the ones `McStore::commit_transform` issues (crates/mc-store/src/lib.rs),
run with the same pragmas a ck-mc connection gets (WAL, synchronous=FULL, autocheckpoint
1000 pages, 4 KiB pages). Each scenario runs in its own process against its own APFS clone,
so the process's own disk-write counter is the cost of exactly that scenario.

usage: sqlexp.py <golden store.db> <work dir> <session_id> [scenario ...]
Scenarios:
  before_append   today's layout: one new-message commit (two frozen units appended,
                  pass scalars changed), cache row + digest + pass trace
  before_meta     today's layout: a meta-only change of unchanged length (historian claim)
  before_noop     today's layout: a pass whose blobs are unchanged (no row write)
  after_append    proposed layout: small row + two appended unit rows + pass trace
  after_append_ring  proposed layout with the scheduler histories as ring rows
  after_chunked   proposed layout with frozen units in fixed 64-unit chunks (SQLEXP_CHUNK)
  migrate         proposed layout: cost of splitting every session once
  migrate_chunked the same with chunked frozen units
"""
import ctypes, json, os, shutil, sqlite3, subprocess, sys, time

GOLDEN, WORK, SESSION = sys.argv[1], sys.argv[2], sys.argv[3]
SCENARIOS = sys.argv[4:] or ["before_noop", "before_append", "before_meta", "after_append", "after_append_ring", "migrate"]
COMMITS = int(os.environ.get("SQLEXP_COMMITS", "10"))
LARGE = ("resolved_compartment_boundaries", "tail_hygiene_baseline")
CHUNK = int(os.environ.get("SQLEXP_CHUNK", "64"))
CHUNKED = any(s in ("after_chunked", "migrate_chunked") for s in SCENARIOS)

libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


class RUsageV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f"f{i}", ctypes.c_uint64) for i in range(16)] + [
        ("bytesread", ctypes.c_uint64), ("byteswritten", ctypes.c_uint64)]


def self_written():
    ru = RUsageV2()
    libc.proc_pid_rusage(os.getpid(), 2, ctypes.byref(ru))
    return ru.byteswritten


def wal_frames(path):
    try:
        size = os.path.getsize(path + "-wal")
    except FileNotFoundError:
        return 0
    return max(0, (size - 32) // (24 + 4096))


def connect(path, autocheckpoint):
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("pragma journal_mode=WAL")
    conn.execute("pragma synchronous=FULL")
    conn.execute(f"pragma wal_autocheckpoint={autocheckpoint}")
    conn.execute("pragma foreign_keys=ON")
    return conn


PASS_TRACE_SQL = """
INSERT INTO mc_pass_trace (session_id, last_received_at_ms, last_completed_at_ms, last_reject_error,
    last_reject_at_ms, reject_count, receive_count, first_divergence, last_divergence,
    scheduler_history, scheduler_interesting_history)
VALUES (?1, 0, 0, NULL, NULL, 0, 0, NULL, NULL, json_array(json(?2)), '[]')
ON CONFLICT(session_id) DO UPDATE SET
    first_divergence = excluded.first_divergence,
    scheduler_history = CASE
        WHEN json_array_length(mc_pass_trace.scheduler_history) < 256 THEN
            json_insert(mc_pass_trace.scheduler_history, '$[#]', json(?2))
        ELSE json_insert((SELECT json_group_array(json(value)) FROM json_each(mc_pass_trace.scheduler_history)
                          WHERE key >= json_array_length(mc_pass_trace.scheduler_history) - 255), '$[#]', json(?2))
    END
"""
OBSERVATION = json.dumps({"pass": "defer", "defer_reason": "below_threshold", "drain_latch": False,
                          "at_ms": 1790838643841, "identity_delta": []})


def load(conn):
    rv, core, meta = conn.execute(
        "select row_version, core_state, meta from mc_cache_state where session_id=?", (SESSION,)).fetchone()
    return rv, json.loads(core), json.loads(meta)


def step(core, meta, i):
    """One new-message pass, as observed on the live store: two frozen units appended and
    the per-pass scalars moved. Nothing else in the row changes."""
    tail = core["frozen_units"][-2:]
    for n, unit in enumerate(tail):
        new = dict(unit)
        new["key"] = f"{unit['key']}:probe{i}:{n}"
        core["frozen_units"].append(new)
    meta["last_committed_pass_at_ms"] = 1790838643841 + i * 1000
    meta["newest_live_ordinal"] = meta.get("newest_live_ordinal", 0) + 1
    usage = meta.get("last_usage") or {}
    usage["current_total_input_tokens"] = 400000 + i
    meta["last_usage"] = usage


def dumps(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def scenario(name):
    path = os.path.join(WORK, name, "store.db")
    shutil.rmtree(os.path.dirname(path), ignore_errors=True)
    os.makedirs(os.path.dirname(path))
    subprocess.run(["cp", "-c", GOLDEN, path], check=True)
    conn = connect(path, 1000)
    rv, core, meta = load(conn)
    result = {"scenario": name, "core_bytes": len(dumps(core)), "meta_bytes": len(dumps(meta))}
    if name.startswith("after") or name.startswith("migrate"):
        started = time.time()
        conn.execute("pragma wal_checkpoint(TRUNCATE)")
        w0 = self_written()
        migrate(conn)
        conn.execute("pragma wal_checkpoint(TRUNCATE)")
        result["migrate_written"] = self_written() - w0
        result["migrate_seconds"] = round(time.time() - started, 2)
        if name.startswith("after"):
            started = time.time()
            if name == "after_chunked":
                rows = conn.execute("select units from mc_cache_frozen_chunks where session_id=? order by chunk", (SESSION,)).fetchall()
            else:
                rows = conn.execute("select unit from mc_cache_frozen_units where session_id=? order by position", (SESSION,)).fetchall()
            result["load_units_ms"] = round((time.time() - started) * 1000, 1)
            result["load_rows"] = len(rows)
        if name.startswith("migrate"):
            result["sizes_after"] = dict(conn.execute(
                "select name, sum(pgsize) from dbstat where name like 'mc_cache%' group by name").fetchall())
            return result
    if name == "after_append_ring":
        conn.execute("""CREATE TABLE IF NOT EXISTS mc_pass_trace_history (session_id TEXT NOT NULL,
            slot INTEGER NOT NULL, observation TEXT NOT NULL, PRIMARY KEY (session_id, slot))""")
    conn.execute("pragma wal_checkpoint(TRUNCATE)")
    for mode in ("frames", "written"):
        # Frames: checkpoints off, so the WAL keeps every frame the commits wrote.
        # Written: the live configuration, so checkpoint copies are included.
        conn.execute(f"pragma wal_autocheckpoint={0 if mode == 'frames' else 1000}")
        conn.execute("pragma wal_checkpoint(TRUNCATE)")
        f0, w0 = wal_frames(path), self_written()
        for i in range(COMMITS):
            rv = commit(conn, name, rv, core, meta, i + (0 if mode == "frames" else COMMITS))
        if mode == "frames":
            result["wal_frames_per_commit"] = (wal_frames(path) - f0) / COMMITS
            result["wal_bytes_per_commit"] = result["wal_frames_per_commit"] * (24 + 4096)
        else:
            result["written_per_commit"] = (self_written() - w0) / COMMITS
    return result


def commit(conn, name, rv, core, meta, i):
    conn.execute("BEGIN IMMEDIATE")
    current = conn.execute("select row_version from mc_cache_state where session_id=?", (SESSION,)).fetchone()[0]
    assert current == rv, (current, rv)
    if name == "before_noop":
        core_json, meta_json = dumps(core), dumps(meta)
        same = conn.execute("select core_state = ? and meta = ? from mc_cache_state where session_id=?",
                            (core_json, meta_json, SESSION)).fetchone()[0]
        conn.execute("COMMIT")
        return rv
    if name == "before_meta":
        # A same-length meta change: SQLite overwrites the record in place and skips
        # pages whose bytes did not change.
        meta["last_committed_pass_at_ms"] = 1790838643841 + i
        conn.execute("UPDATE mc_cache_state SET row_version=?2, meta=?3 WHERE session_id=?1",
                     (SESSION, rv + 1, dumps(meta)))
        conn.execute("COMMIT")
        return rv + 1
    step(core, meta, i)
    if name == "before_append":
        conn.execute("""INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
            VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(session_id) DO UPDATE SET row_version = excluded.row_version,
            core_state = excluded.core_state, meta = excluded.meta, last_activity_at = excluded.last_activity_at""",
                     (SESSION, rv + 1, dumps(core), dumps(meta), int(time.time() * 1000)))
    else:
        small_core = {k: v for k, v in core.items() if k != "frozen_units"}
        small_meta = {k: v for k, v in meta.items() if k not in LARGE}
        conn.execute("""INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
            VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(session_id) DO UPDATE SET row_version = excluded.row_version,
            core_state = excluded.core_state, meta = excluded.meta, last_activity_at = excluded.last_activity_at""",
                     (SESSION, rv + 1, dumps(small_core), dumps(small_meta), int(time.time() * 1000)))
        start = len(core["frozen_units"]) - 2
        if name == "after_chunked":
            # Fixed-size chunks by position: an append rewrites only the chunk it lands in.
            for chunk in sorted({p // CHUNK for p in range(start, len(core["frozen_units"]))}):
                body = dumps(core["frozen_units"][chunk * CHUNK:(chunk + 1) * CHUNK])
                conn.execute("""INSERT INTO mc_cache_frozen_chunks (session_id, chunk, units) VALUES (?1, ?2, ?3)
                    ON CONFLICT(session_id, chunk) DO UPDATE SET units = excluded.units""", (SESSION, chunk, body))
            start = len(core["frozen_units"])
        for position in range(start, len(core["frozen_units"])):
            conn.execute("""INSERT INTO mc_cache_frozen_units (session_id, position, unit) VALUES (?1, ?2, ?3)
                ON CONFLICT(session_id, position) DO UPDATE SET unit = excluded.unit""",
                         (SESSION, position, dumps(core["frozen_units"][position])))
        # The large sections did not change in this pass, so the commit only reads their
        # recorded hashes to establish that, and writes none of them.
        conn.execute("select content_hash from mc_cache_sections where session_id=?", (SESSION,)).fetchall()
    conn.execute("""INSERT INTO mc_cache_state_digest (session_id, row_version, row_state_fingerprint) VALUES (?1, ?2, ?3)
        ON CONFLICT(session_id) DO UPDATE SET row_version = excluded.row_version,
        row_state_fingerprint = excluded.row_state_fingerprint""", (SESSION, rv + 1, f"probe:{i}"))
    if name == "after_append_ring":
        conn.execute("""INSERT INTO mc_pass_trace_history (session_id, slot, observation) VALUES (?1, ?2, ?3)
            ON CONFLICT(session_id, slot) DO UPDATE SET observation = excluded.observation""",
                     (SESSION, (rv + 1) % 256, OBSERVATION))
    else:
        conn.execute(PASS_TRACE_SQL, (SESSION, OBSERVATION))
    conn.execute("COMMIT")
    return rv + 1


def migrate(conn):
    """The proposed split, applied to every session the way a migration would."""
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("""CREATE TABLE mc_cache_frozen_units (session_id TEXT NOT NULL, position INTEGER NOT NULL,
        unit TEXT NOT NULL, PRIMARY KEY (session_id, position))""")
    conn.execute("""CREATE TABLE mc_cache_sections (session_id TEXT NOT NULL, name TEXT NOT NULL,
        content_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, name))""")
    conn.execute("""CREATE TABLE mc_cache_frozen_chunks (session_id TEXT NOT NULL, chunk INTEGER NOT NULL,
        units TEXT NOT NULL, PRIMARY KEY (session_id, chunk))""")
    rows = conn.execute("select session_id, core_state, meta from mc_cache_state").fetchall()
    for session_id, core_json, meta_json in rows:
        core, meta = json.loads(core_json), json.loads(meta_json)
        units = core.pop("frozen_units", [])
        if CHUNKED:
            for chunk in range(0, len(units), CHUNK):
                conn.execute("insert into mc_cache_frozen_chunks values (?, ?, ?)",
                             (session_id, chunk // CHUNK, dumps(units[chunk:chunk + CHUNK])))
        else:
            for position, unit in enumerate(units):
                conn.execute("insert into mc_cache_frozen_units values (?, ?, ?)", (session_id, position, dumps(unit)))
        for section in LARGE:
            if section in meta:
                body = dumps(meta.pop(section))
                conn.execute("insert into mc_cache_sections values (?, ?, ?, ?)",
                             (session_id, section, str(hash(body)), body))
        conn.execute("update mc_cache_state set core_state=?, meta=? where session_id=?",
                     (dumps(core), dumps(meta), session_id))
    conn.execute("COMMIT")


if __name__ == "__main__":
    if len(SCENARIOS) == 1:
        print(json.dumps(scenario(SCENARIOS[0])))
    else:
        for s in SCENARIOS:
            out = subprocess.run([sys.executable, __file__, GOLDEN, WORK, SESSION, s], capture_output=True, text=True)
            print(out.stdout.strip() or out.stderr.strip()[-2000:], flush=True)
