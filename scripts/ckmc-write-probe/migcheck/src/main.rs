//! Probe for the proposed store.db migration 63 (see ../migration63.sql and the design note
//! docs/reports/ckmc-write-amplification-design.md). It only ever opens the paths it is
//! given, and those must be APFS clones: never point it at a live store.
//!
//!   migcheck migrate  <db>                     run migration63.sql in one transaction
//!   migcheck verify   <original.db> <migrated.db>   compare every moved value with the original
//!   migcheck fixtures                          in-memory shape fixtures: scalars, nulls, guards
//!   migcheck loadcost <original.db> <migrated.db> <session> <iterations>
//!
//! Build with `--features exact` for `verify` (numbers compared by their text, object key
//! order kept) and without it for `loadcost` (the parser ck-mc actually uses).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::time::Instant;

const MIGRATION: &str = include_str!("../migration63.sql");
const CHUNK: usize = 64;
const REQUEST_CARRIER: &str = "__request_trace_history__";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("migrate") => migrate(&args[2]),
        Some("verify") => verify(&args[2], &args[3]),
        Some("fixtures") => fixtures(),
        Some("loadcost") => loadcost(&args[2], &args[3], &args[4], args[5].parse().unwrap()),
        _ => {
            eprintln!("usage: migcheck migrate|verify|fixtures|loadcost ...");
            std::process::exit(2);
        }
    }
}

fn open(path: &str) -> Connection {
    let conn = Connection::open(path).expect("open");
    // Match a ck-mc connection (cortexkit_store::open_sqlite), so the WAL bytes reported below
    // are what ck-mc would write: WAL journaling, with synchronous and the autocheckpoint left
    // at SQLite's defaults because open_sqlite does not set them either.
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
    conn
}

fn wal_bytes(path: &str) -> u64 {
    std::fs::metadata(format!("{path}-wal")).map(|m| m.len()).unwrap_or(0)
}

/// The migration text: migration63.sql as compiled in, or the file named by MIGCHECK_SQL, so a
/// deliberately broken variant can show that `verify` catches it.
fn migration_sql() -> String {
    match std::env::var("MIGCHECK_SQL") {
        Ok(path) => std::fs::read_to_string(path).expect("MIGCHECK_SQL"),
        Err(_) => MIGRATION.to_string(),
    }
}

fn migrate(path: &str) {
    let conn = open(path);
    let version: String = conn.query_row("select sqlite_version()", [], |r| r.get(0)).unwrap();
    let wal_before = wal_bytes(path);
    let started = Instant::now();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    if let Err(error) = conn.execute_batch(&migration_sql()) {
        conn.execute_batch("ROLLBACK").ok();
        println!("migrate sqlite_version={version} FAILED: {error}");
        std::process::exit(1);
    }
    conn.execute_batch("COMMIT").unwrap();
    let seconds = started.elapsed().as_secs_f64();
    let q = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    println!(
        "migrate sqlite_version={version} seconds={seconds:.2} wal_bytes={} chunk_rows={} chunk_body_bytes={} \
         section_rows={} section_body_bytes={} small_core_bytes={} small_meta_bytes={} trace_history_rows={}",
        wal_bytes(path) - wal_before,
        q("select count(*) from mc_cache_frozen_chunks"),
        q("select coalesce(sum(length(body)),0) from mc_cache_frozen_chunks"),
        q("select count(*) from mc_cache_sections"),
        q("select coalesce(sum(length(body)),0) from mc_cache_sections"),
        q("select coalesce(sum(length(core_state)),0) from mc_cache_state"),
        q("select coalesce(sum(length(meta)),0) from mc_cache_state"),
        q("select count(*) from mc_pass_trace_history"),
    );
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

#[derive(Default)]
struct Tally {
    rows: usize,
    exact: usize,
    mismatched: usize,
    shadow_rows: usize,
    rows_with_u0000: usize,
    empty_frozen_units: usize,
    rows_with_boundaries: usize,
    rows_with_tail: usize,
    units: usize,
    chunks: usize,
    chunks_byte_identical: usize,
    small_core_byte_identical: usize,
    small_meta_byte_identical: usize,
    sections_byte_identical: usize,
    sections: usize,
    moved_key_in_small_blob: usize,
    index_mismatch: usize,
    first_mismatch: Option<String>,
}

fn verify(original: &str, migrated: &str) {
    let orig = Connection::open(original).unwrap();
    let mig = Connection::open(migrated).unwrap();
    let mut t = Tally::default();
    let mut statement = orig
        .prepare("select session_id, core_state, meta from mc_cache_state order by session_id")
        .unwrap();
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .unwrap();
    for row in rows {
        let (session, core_text, meta_text) = row.unwrap();
        t.rows += 1;
        if session.starts_with("shadow:") {
            t.shadow_rows += 1;
        }
        if core_text.contains("\\u0000") || meta_text.contains("\\u0000") {
            t.rows_with_u0000 += 1;
        }
        let mut core = parse(&core_text);
        let mut meta = parse(&meta_text);
        // `retain`, not `remove`: with preserve_order, `remove` swaps the last key into the
        // hole, which would make the byte comparison below fail for a reason of our own.
        let core_obj = core.as_object_mut().unwrap();
        let units = match core_obj.get("frozen_units").cloned() {
            Some(Value::Array(units)) => units,
            None => Vec::new(),
            Some(other) => panic!("{session}: frozen_units is {other}"),
        };
        core_obj.retain(|key, _| key != "frozen_units");
        let meta_obj = meta.as_object_mut().unwrap();
        let boundaries = match meta_obj.get("resolved_compartment_boundaries").cloned() {
            Some(Value::Array(list)) if !list.is_empty() => Some(Value::Array(list)),
            _ => None,
        };
        let tail = match meta_obj.get("tail_hygiene_baseline").cloned() {
            Some(Value::Object(object)) => Some(Value::Object(object)),
            _ => None,
        };
        meta_obj.retain(|key, _| key != "resolved_compartment_boundaries" && key != "tail_hygiene_baseline");
        if units.is_empty() {
            t.empty_frozen_units += 1;
        }
        t.units += units.len();
        t.rows_with_boundaries += boundaries.is_some() as usize;
        t.rows_with_tail += tail.is_some() as usize;

        let (small_core_text, small_meta_text, index_text): (String, String, String) = mig
            .query_row(
                "select core_state, meta, section_index from mc_cache_state where session_id = ?1",
                params![session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let mut chunk_statement = mig
            .prepare_cached("select chunk, body from mc_cache_frozen_chunks where session_id = ?1 order by chunk")
            .unwrap();
        let chunks: Vec<(i64, String)> = chunk_statement
            .query_map(params![session], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut got_units = Vec::new();
        let mut positions_ok = true;
        for (position, (chunk, body)) in chunks.iter().enumerate() {
            positions_ok &= *chunk == position as i64;
            let slice = &units[(position * CHUNK).min(units.len())..((position + 1) * CHUNK).min(units.len())];
            t.chunks += 1;
            if serde_json::to_string(&slice).unwrap() == *body {
                t.chunks_byte_identical += 1;
            }
            match parse(body) {
                Value::Array(list) => got_units.extend(list),
                other => panic!("{session}: chunk {chunk} is {other}"),
            }
        }
        let section = |name: &str| -> Option<String> {
            mig.query_row(
                "select body from mc_cache_sections where session_id = ?1 and section = ?2",
                params![session, name],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
        };
        let got_boundaries_text = section("resolved_compartment_boundaries");
        let got_tail_text = section("tail_hygiene_baseline");
        for (want, got) in [(&boundaries, &got_boundaries_text), (&tail, &got_tail_text)] {
            if let (Some(want), Some(got)) = (want, got) {
                t.sections += 1;
                if serde_json::to_string(want).unwrap() == *got {
                    t.sections_byte_identical += 1;
                }
            }
        }
        let got_boundaries = got_boundaries_text.as_deref().map(parse);
        let got_tail = got_tail_text.as_deref().map(parse);
        let small_core = parse(&small_core_text);
        let small_meta = parse(&small_meta_text);
        if serde_json::to_string(&core).unwrap() == small_core_text {
            t.small_core_byte_identical += 1;
        }
        if serde_json::to_string(&meta).unwrap() == small_meta_text {
            t.small_meta_byte_identical += 1;
        }
        let moved = small_core.get("frozen_units").is_some()
            || small_meta.get("resolved_compartment_boundaries").is_some()
            || small_meta.get("tail_hygiene_baseline").is_some();
        t.moved_key_in_small_blob += moved as usize;

        let index = parse(&index_text);
        let index_ok = index["sv"] == 0
            && index["f"]["n"] == units.len()
            && index["f"]["c"] == chunks.len()
            && chunks.len() == units.len().div_ceil(CHUNK)
            && index.get("b").is_some() == boundaries.is_some()
            && index.get("b").map_or(true, |b| {
                b["n"] == boundaries.as_ref().map_or(0, |list| list.as_array().unwrap().len())
            })
            && index.get("t").is_some() == tail.is_some();
        if !index_ok {
            t.index_mismatch += 1;
        }

        let parts = [
            ("frozen_units", got_units == units && positions_ok),
            ("boundaries", got_boundaries == boundaries),
            ("tail", got_tail == tail),
            ("small_core", small_core == core),
            ("small_meta", small_meta == meta),
            ("section_index", index_ok),
            ("no_moved_key", !moved),
        ];
        if parts.iter().all(|(_, ok)| *ok) {
            t.exact += 1;
        } else {
            t.mismatched += 1;
            if t.first_mismatch.is_none() {
                t.first_mismatch = Some(format!("{session} {parts:?}"));
            }
        }
    }
    println!(
        "verify rows={} exact={} mismatched={} shadow_rows={} rows_with_u0000={} empty_frozen_units={} \
         rows_with_boundaries={} rows_with_tail={} units={} chunks={} index_mismatch={} moved_key_in_small_blob={}",
        t.rows, t.exact, t.mismatched, t.shadow_rows, t.rows_with_u0000, t.empty_frozen_units,
        t.rows_with_boundaries, t.rows_with_tail, t.units, t.chunks, t.index_mismatch, t.moved_key_in_small_blob
    );
    println!(
        "bytes (meaningful only with --features exact): chunks_byte_identical={}/{} sections_byte_identical={}/{} \
         small_core_byte_identical={}/{} small_meta_byte_identical={}/{}",
        t.chunks_byte_identical, t.chunks, t.sections_byte_identical, t.sections,
        t.small_core_byte_identical, t.rows, t.small_meta_byte_identical, t.rows
    );
    if let Some(first) = t.first_mismatch {
        println!("first_mismatch={first}");
    }
    verify_trace(&orig, &mig);
}

/// Check the pass-trace move: for every `mc_pass_trace` row, the `scheduler_history`,
/// `scheduler_interesting_history` and request-history arrays rebuilt from ring rows through
/// the `mc_pass_trace_history_arrays` view must equal the arrays stored before the migration.
fn verify_trace(orig: &Connection, mig: &Connection) {
    let mut statement = orig
        .prepare("select session_id, scheduler_history, scheduler_interesting_history from mc_pass_trace")
        .unwrap();
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .unwrap();
    let (mut total, mut exact, mut entries) = (0usize, 0usize, 0usize);
    let mut first: Option<String> = None;
    for row in rows {
        let (session, scheduler_text, interesting_text) = row.unwrap();
        total += 1;
        let scheduler = parse(&scheduler_text);
        let mut interesting = match parse(&interesting_text) {
            Value::Array(list) => list,
            other => panic!("{session}: interesting history is {other}"),
        };
        let carrier = interesting.iter().rposition(|entry| {
            entry.get("scheduler_decision").and_then(Value::as_str) == Some(REQUEST_CARRIER)
        });
        let request = carrier
            .map(|index| interesting[index].get("request_history").cloned().unwrap_or(Value::Array(vec![])))
            .unwrap_or(Value::Array(vec![]));
        // ck-mc stores the request history inside one extra "interesting" entry whose
        // scheduler_decision is the carrier marker. Only the newest such entry holds the live
        // request history, but the migration drops every marker entry from the interesting
        // ring, because none of them is a real scheduler observation.
        interesting.retain(|entry| {
            entry.get("scheduler_decision").and_then(Value::as_str) != Some(REQUEST_CARRIER)
        });
        entries += scheduler.as_array().map_or(0, Vec::len) + interesting.len() + request.as_array().map_or(0, Vec::len);
        let (got_scheduler, got_interesting, got_request): (String, String, String) = mig
            .query_row(
                "select scheduler_history, scheduler_interesting_history, request_history
                   from mc_pass_trace_history_arrays where session_id = ?1",
                params![session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let ok = parse(&got_scheduler) == scheduler
            && parse(&got_interesting) == Value::Array(interesting)
            && parse(&got_request) == request;
        if ok {
            exact += 1;
        } else if first.is_none() {
            first = Some(session);
        }
    }
    println!("verify_trace rows={total} exact={exact} entries={entries} first_mismatch={first:?}");
}

/// Shape fixtures the live store does not contain: scalar elements, JSON nulls, a missing
/// list. Each runs the real migration on an in-memory store with the two tables it reads.
fn fixtures() {
    let cases: &[(&str, &str, &str)] = &[
        ("objects with nested edge numbers and a NUL key", r#"{"frozen_units":[{"k":"a\u0000b","f":0.30000000000000004,"u":18446744073709551615,"e":1e400}]}"#, r#"{}"#),
        ("a scalar frozen unit", r#"{"frozen_units":[{"k":1},0.30000000000000004]}"#, r#"{}"#),
        ("tail baseline is JSON null", r#"{"frozen_units":[]}"#, r#"{"tail_hygiene_baseline":null}"#),
        ("boundaries are JSON null", r#"{"frozen_units":[]}"#, r#"{"resolved_compartment_boundaries":null}"#),
        ("a scalar boundary", r#"{"frozen_units":[]}"#, r#"{"resolved_compartment_boundaries":[7]}"#),
        ("frozen_units missing", r#"{"boundary_id":"b"}"#, r#"{}"#),
        ("frozen_units is an object", r#"{"frozen_units":{}}"#, r#"{}"#),
        ("tail baseline is a string", r#"{"frozen_units":[]}"#, r#"{"tail_hygiene_baseline":"x"}"#),
    ];
    for (label, core, meta) in cases {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table mc_cache_state (session_id text primary key, row_version integer, core_state text, meta text);
             create table mc_pass_trace (session_id text primary key, scheduler_history text not null default '[]',
                                         scheduler_interesting_history text not null default '[]');",
        )
        .unwrap();
        conn.execute("insert into mc_cache_state values ('s', 1, ?1, ?2)", params![core, meta]).unwrap();
        conn.execute_batch("BEGIN").unwrap();
        match conn.execute_batch(MIGRATION) {
            Err(error) => {
                conn.execute_batch("ROLLBACK").ok();
                let still_old: bool = conn
                    .query_row("select count(*) = 0 from sqlite_master where name = 'mc_cache_frozen_chunks'", [], |r| r.get(0))
                    .unwrap();
                println!("fixture [{label}]: REFUSED ({error}); rolled back cleanly: {still_old}");
            }
            Ok(()) => {
                conn.execute_batch("COMMIT").unwrap();
                let chunks: Vec<String> = conn
                    .prepare("select body from mc_cache_frozen_chunks order by chunk").unwrap()
                    .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
                let sections: Vec<(String, String)> = conn
                    .prepare("select section, body from mc_cache_sections order by section").unwrap()
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
                let (small_core, small_meta, index): (String, String, String) = conn
                    .query_row("select core_state, meta, section_index from mc_cache_state", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap();
                println!("fixture [{label}]: migrated chunks={chunks:?} sections={sections:?} core={small_core} meta={small_meta} index={index}");
            }
        }
    }
}

/// A copy of mc-store's `row_state_hash_128` (crates/mc-store/src/lib.rs), which the design
/// uses for the per-chunk and per-section digests, so `loadcost` times the real hash. Written
/// with `chunks_exact` instead of the slice `as_chunks` method, which needs a newer compiler.
fn row_state_hash_128(bytes: &[u8]) -> u128 {
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    const MURMUR_C1: u64 = 0xff51_afd7_ed55_8ccd;
    const MURMUR_C2: u64 = 0xc4ce_b9fe_1a85_ec53;
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x9e37_79b9_7f4a_7c15;
    let mix = |word: u64, a: &mut u64, b: &mut u64| {
        *a = (*a ^ word).wrapping_mul(FNV_PRIME);
        *b = b.rotate_left(31).wrapping_add(word).wrapping_mul(MURMUR_C1);
        *b ^= *b >> 33;
    };
    let words = bytes.chunks_exact(8);
    let remainder = words.remainder();
    for word in words {
        mix(u64::from_le_bytes(word.try_into().unwrap()), &mut a, &mut b);
    }
    let mut tail = [0u8; 8];
    tail[..remainder.len()].copy_from_slice(remainder);
    mix(u64::from_le_bytes(tail) ^ (bytes.len() as u64), &mut a, &mut b);
    a ^= a >> 33;
    a = a.wrapping_mul(MURMUR_C2);
    a ^= a >> 29;
    b ^= b >> 32;
    b = b.wrapping_mul(MURMUR_C2);
    b ^= b >> 31;
    (u128::from(a) << 64) | u128::from(b)
}

fn stats(label: &str, mut samples: Vec<f64>) {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "  {label:<44} min {:>7.2} ms  median {:>7.2} ms",
        samples[0],
        samples[samples.len() / 2]
    );
}

fn time<F: FnMut()>(iterations: usize, mut f: F) -> Vec<f64> {
    (0..iterations)
        .map(|_| {
            let started = Instant::now();
            f();
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect()
}

/// Read costs per load path, today against the split layout, for one session.
/// Parsing goes into serde_json::Value, a proxy for the typed structs: compare layouts, not
/// absolute milliseconds.
fn loadcost(original: &str, migrated: &str, session: &str, iterations: usize) {
    let orig = Connection::open(original).unwrap();
    let mig = Connection::open(migrated).unwrap();
    let chunk_rows: i64 = mig
        .query_row("select count(*) from mc_cache_frozen_chunks where session_id = ?1", params![session], |r| r.get(0))
        .unwrap();
    println!("loadcost session={session} iterations={iterations} chunk_rows={chunk_rows}");

    stats("today: full read", time(iterations, || {
        let tx = orig.unchecked_transaction().unwrap();
        let _: (i64, String, String) = tx
            .query_row("select row_version, core_state, meta from mc_cache_state where session_id = ?1", params![session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
    }));
    stats("today: full read + parse", time(iterations, || {
        let tx = orig.unchecked_transaction().unwrap();
        let (_, core, meta): (i64, String, String) = tx
            .query_row("select row_version, core_state, meta from mc_cache_state where session_id = ?1", params![session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        std::hint::black_box((parse(&core), parse(&meta)));
    }));
    stats("today: boundary json_extract (cached_context_boundaries)", time(iterations, || {
        let text: String = orig
            .query_row("SELECT COALESCE(json_extract(meta, '$.resolved_compartment_boundaries'), '[]') FROM mc_cache_state WHERE session_id=?1", params![session], |r| r.get(0))
            .unwrap();
        std::hint::black_box(text);
    }));
    stats("today: serialize core (commit_transform)", {
        let core: String = orig.query_row("select core_state from mc_cache_state where session_id = ?1", params![session], |r| r.get(0)).unwrap();
        let core = parse(&core);
        time(iterations, || {
            std::hint::black_box(serde_json::to_string(&core).unwrap());
        })
    });

    let read_split = |with_sections: bool| -> (String, String, String, Vec<String>, Vec<String>) {
        let tx = mig.unchecked_transaction().unwrap();
        let (core, meta, index): (String, String, String) = tx
            .query_row("select core_state, meta, section_index from mc_cache_state where session_id = ?1", params![session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        let (mut chunks, mut sections) = (Vec::new(), Vec::new());
        if with_sections {
            let mut s = tx.prepare_cached("select body from mc_cache_frozen_chunks where session_id = ?1 order by chunk").unwrap();
            chunks = s.query_map(params![session], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            let mut s = tx.prepare_cached("select body from mc_cache_sections where session_id = ?1 order by section").unwrap();
            sections = s.query_map(params![session], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        }
        (core, meta, index, chunks, sections)
    };
    stats("split: full read", time(iterations, || {
        std::hint::black_box(read_split(true));
    }));
    stats("split: full read + parse", time(iterations, || {
        let (core, meta, index, chunks, sections) = read_split(true);
        let parsed: Vec<Value> = chunks.iter().map(|c| parse(c)).collect();
        let parsed_sections: Vec<Value> = sections.iter().map(|s| parse(s)).collect();
        std::hint::black_box((parse(&core), parse(&meta), parse(&index), parsed, parsed_sections));
    }));
    stats("split: digest of every chunk and section", {
        let (_, _, _, chunks, sections) = read_split(true);
        time(iterations, || {
            let per_chunk: Vec<u128> = chunks.iter().map(|c| row_state_hash_128(c.as_bytes())).collect();
            let mut joined = Vec::with_capacity(per_chunk.len() * 16);
            for h in &per_chunk {
                joined.extend_from_slice(&h.to_le_bytes());
            }
            std::hint::black_box(row_state_hash_128(&joined));
            for s in &sections {
                std::hint::black_box(row_state_hash_128(s.as_bytes()));
            }
        })
    });
    stats("split: small row only, read + parse (commit_meta)", time(iterations, || {
        let (core, meta, index, _, _) = read_split(false);
        std::hint::black_box((parse(&core), parse(&meta), parse(&index)));
    }));
    stats("split: small row + tail section, read + parse (status)", time(iterations, || {
        let tx = mig.unchecked_transaction().unwrap();
        let (core, meta): (String, String) = tx
            .query_row("select core_state, meta from mc_cache_state where session_id = ?1", params![session], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let tail: Option<String> = tx
            .query_row("select body from mc_cache_sections where session_id = ?1 and section = 'tail_hygiene_baseline'", params![session], |r| r.get(0))
            .optional()
            .unwrap();
        std::hint::black_box((parse(&core), parse(&meta), tail.map(|t| parse(&t))));
    }));
    stats("split: boundary key only (hash in section_index)", time(iterations, || {
        let key: Option<String> = mig
            .query_row("select json_extract(section_index, '$.b') from mc_cache_state where session_id = ?1", params![session], |r| r.get(0))
            .optional()
            .unwrap()
            .flatten();
        std::hint::black_box(key);
    }));
    stats("split: boundary section body read", time(iterations, || {
        let body: Option<String> = mig
            .query_row("select body from mc_cache_sections where session_id = ?1 and section = 'resolved_compartment_boundaries'", params![session], |r| r.get(0))
            .optional()
            .unwrap();
        std::hint::black_box(body);
    }));
    stats("split: serialize + hash every chunk (encoder)", {
        let (_, _, _, chunks, _) = read_split(true);
        let parsed: Vec<Value> = chunks.iter().map(|c| parse(c)).collect();
        time(iterations, || {
            for chunk in &parsed {
                let text = serde_json::to_string(chunk).unwrap();
                std::hint::black_box(row_state_hash_128(text.as_bytes()));
            }
        })
    });
}
