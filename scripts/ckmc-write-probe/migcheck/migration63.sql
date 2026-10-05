-- The proposed store.db migration 63, exactly as the design note specifies it.
-- migcheck.rs runs this file unchanged against a clone of the whole store and checks every
-- row it moves. It must stay plain SQL: cortexkit-store migrations are static SQL batches
-- run inside one transaction together with their version record.
--
-- SQLite 3.46.0 (libsqlite3-sys 0.30.1, the version ck-mc links) or newer is required for
-- ORDER BY inside an aggregate.

-- 1. Shape guards. Each INSERT counts the rows the codec could not round-trip, and the CHECK
--    fails the whole migration, rolling it back, if any count is not zero. The store then
--    stays at version 62 and an older binary can still open it.
CREATE TEMP TABLE mc_migration_63_guard (
    problem TEXT NOT NULL,
    bad_rows INTEGER NOT NULL CHECK (bad_rows = 0)
);
INSERT INTO mc_migration_63_guard
SELECT 'core_state.frozen_units is present but not an array', COUNT(*)
  FROM mc_cache_state
 WHERE json_type(core_state, '$.frozen_units') NOT IN ('array');
INSERT INTO mc_migration_63_guard
SELECT 'a frozen unit is not a JSON object', COUNT(*)
  FROM mc_cache_state AS s, json_each(s.core_state, '$.frozen_units') AS e
 WHERE json_type(s.core_state, '$.frozen_units') = 'array' AND e.type <> 'object';
INSERT INTO mc_migration_63_guard
SELECT 'meta.resolved_compartment_boundaries is present but not an array', COUNT(*)
  FROM mc_cache_state
 WHERE json_type(meta, '$.resolved_compartment_boundaries') NOT IN ('array', 'null');
INSERT INTO mc_migration_63_guard
SELECT 'a resolved compartment boundary is not a JSON object', COUNT(*)
  FROM mc_cache_state AS s, json_each(s.meta, '$.resolved_compartment_boundaries') AS e
 WHERE json_type(s.meta, '$.resolved_compartment_boundaries') = 'array' AND e.type <> 'object';
INSERT INTO mc_migration_63_guard
SELECT 'meta.tail_hygiene_baseline is present but not an object', COUNT(*)
  FROM mc_cache_state
 WHERE json_type(meta, '$.tail_hygiene_baseline') NOT IN ('object', 'null');
DROP TABLE mc_migration_63_guard;

-- 2. Frozen units: fixed-size positional chunks of 64 units.
--    json(e.value) is required. Under GROUP BY, SQLite's sorter drops the JSON subtype of
--    json_each.value, and json_group_array(e.value) then stores every unit as a JSON string.
CREATE TABLE mc_cache_frozen_chunks (
    session_id TEXT    NOT NULL,
    chunk      INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    PRIMARY KEY (session_id, chunk)
);
INSERT INTO mc_cache_frozen_chunks (session_id, chunk, body)
SELECT s.session_id, e.key / 64, json_group_array(json(e.value) ORDER BY e.key)
  FROM mc_cache_state AS s, json_each(s.core_state, '$.frozen_units') AS e
 GROUP BY s.session_id, e.key / 64;

-- 3. Values replaced wholesale: one row per non-empty section. No row means the section is
--    absent (an empty boundary list, or no tail baseline).
CREATE TABLE mc_cache_sections (
    session_id TEXT NOT NULL,
    section    TEXT NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (session_id, section)
);
INSERT INTO mc_cache_sections (session_id, section, body)
SELECT session_id, 'resolved_compartment_boundaries',
       json_extract(meta, '$.resolved_compartment_boundaries')
  FROM mc_cache_state
 WHERE json_type(meta, '$.resolved_compartment_boundaries') = 'array'
   AND json_array_length(meta, '$.resolved_compartment_boundaries') > 0;
INSERT INTO mc_cache_sections (session_id, section, body)
SELECT session_id, 'tail_hygiene_baseline', json_extract(meta, '$.tail_hygiene_baseline')
  FROM mc_cache_state
 WHERE json_type(meta, '$.tail_hygiene_baseline') = 'object';

-- 4. The small row. section_index records what the chunk and section rows must hold.
--    "sv" is the sections version: 0 marks rows written by this migration, whose digests
--    are filled in by the open-time backfill. Only codec writers set it, always to >= 1.
--    json_patch drops the keys whose value is NULL, so an absent section has no key.
--    Every SET expression reads the row as it was before this UPDATE.
ALTER TABLE mc_cache_state ADD COLUMN section_index TEXT NOT NULL DEFAULT '{}';
UPDATE mc_cache_state SET
    section_index = json_patch('{}', json_object(
        'sv', 0,
        'f', json_object(
            'n', COALESCE(json_array_length(core_state, '$.frozen_units'), 0),
            'c', (COALESCE(json_array_length(core_state, '$.frozen_units'), 0) + 63) / 64),
        'b', CASE WHEN json_array_length(meta, '$.resolved_compartment_boundaries') > 0
                  THEN json_object('n', json_array_length(meta, '$.resolved_compartment_boundaries'))
             END,
        't', CASE WHEN json_type(meta, '$.tail_hygiene_baseline') = 'object'
                  THEN json('{}')
             END)),
    core_state = json_remove(core_state, '$.frozen_units'),
    meta = json_remove(meta, '$.resolved_compartment_boundaries', '$.tail_hygiene_baseline');

-- 5. Pass-trace histories as ring rows. The sequence orders entries; the slot only bounds
--    storage, so readers order by seq and never by slot. The request history lives today in a
--    carrier entry inside scheduler_interesting_history; only the newest carrier counts,
--    as in pass_trace_meta_parts.
CREATE TABLE mc_pass_trace_history (
    session_id TEXT    NOT NULL,
    kind       TEXT    NOT NULL,   -- 'scheduler' | 'interesting' | 'request'
    slot       INTEGER NOT NULL,   -- seq % 256, or seq % 32 for 'request'
    seq        INTEGER NOT NULL,
    entry      TEXT    NOT NULL,
    PRIMARY KEY (session_id, kind, slot)
);
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'scheduler', e.key % 256, e.key, json(e.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_history) AS e;
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'interesting', e.key % 256, e.key, json(e.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_interesting_history) AS e
 WHERE json_extract(e.value, '$.scheduler_decision') IS NOT '__request_trace_history__';
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'request', r.key % 32, r.key, json(r.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_interesting_history) AS c,
       json_each(c.value, '$.request_history') AS r
 WHERE c.key = (SELECT MAX(c2.key) FROM json_each(t.scheduler_interesting_history) AS c2
                 WHERE json_extract(c2.value, '$.scheduler_decision') = '__request_trace_history__');
ALTER TABLE mc_pass_trace ADD COLUMN scheduler_next_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mc_pass_trace ADD COLUMN interesting_next_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mc_pass_trace ADD COLUMN request_next_seq INTEGER NOT NULL DEFAULT 0;
UPDATE mc_pass_trace SET
    scheduler_next_seq = COALESCE(json_array_length(scheduler_history), 0),
    interesting_next_seq = COALESCE(json_array_length(scheduler_interesting_history), 0),
    request_next_seq = COALESCE((SELECT MAX(seq) + 1 FROM mc_pass_trace_history AS h
                                  WHERE h.session_id = mc_pass_trace.session_id
                                    AND h.kind = 'request'), 0);
-- Dropping the array columns makes a reader that names them fail loudly instead of reading
-- a frozen copy. Readers that select * must move to the view below.
ALTER TABLE mc_pass_trace DROP COLUMN scheduler_history;
ALTER TABLE mc_pass_trace DROP COLUMN scheduler_interesting_history;
CREATE VIEW mc_pass_trace_history_arrays AS
SELECT t.session_id,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'scheduler') AS scheduler_history,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'interesting') AS scheduler_interesting_history,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'request') AS request_history
  FROM mc_pass_trace AS t;
