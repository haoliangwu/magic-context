//! What the Cache tab needs from Broca's `run-index.db`, followed across live
//! polls instead of re-derived from the whole store each time.
//!
//! The session list used to group every `export_facts` row by its JSON
//! session identity and scan every `run_index` row for `state = 'active'`
//! (no index on either), and each Broca events fetch filtered every fact by
//! `json_extract(segment_json, '$.session')`. On an 11 GB store that was
//! 43,000 pages plus a 27 MB temporary sort file per list, and 60,000 pages
//! per events fetch, every second.
//!
//! Both tables only grow at the end: `export_facts.export_seq` is an
//! AUTOINCREMENT key Broca only appends to, and a `run_index` row is inserted
//! when a run starts, then updated in place as the run pauses, resumes and
//! ends. So this index reads facts past the highest `export_seq` it has seen,
//! `run_index` rows past the highest rowid, and re-reads by rowid only the runs
//! it last saw open (active or paused). Each session keeps the run ids of its
//! facts, so its run totals are read through the `export_facts(run_id)` index.
//!
//! A full rebuild happens when the store file is replaced, when a table's
//! keys go backwards, and every `FULL_REBUILD_INTERVAL` as a guard against an
//! operator tool rewriting rows in place.

use super::table_exists;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

const FULL_REBUILD_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Default)]
struct SessionFacts {
    /// Newest `occurred_at_ms` among the session's facts; `None` while none
    /// carries one.
    activity: Option<i64>,
    run_ids: BTreeSet<String>,
}

#[derive(Debug)]
struct OpenRun {
    identity: Option<String>,
    state_changed_ms: Option<i64>,
    active: bool,
}

/// One listed Broca session: its JSON identity, newest activity, and whether
/// a run of it is in progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListedSession {
    pub identity: String,
    pub activity: i64,
    pub running: bool,
}

#[derive(Debug, Default)]
pub(super) struct BrocaRunIndex {
    /// Bumped whenever a refresh reads anything new, so `list` can reuse its
    /// last answer while the store stands still (most polls).
    generation: u64,
    list_memo: Option<(u64, usize, Vec<ListedSession>)>,
    built_at: Option<Instant>,
    export_seq: i64,
    run_rowid: i64,
    sessions: HashMap<String, SessionFacts>,
    open_runs: HashMap<i64, OpenRun>,
}

fn is_open(state: &str) -> bool {
    matches!(state, "active" | "paused")
}

impl BrocaRunIndex {
    /// Reads what the store gained since the last refresh.
    pub(super) fn refresh(&mut self, conn: &Connection, now: Instant) -> rusqlite::Result<()> {
        let newest_fact: i64 = conn.query_row(
            "SELECT COALESCE(MAX(export_seq), 0) FROM export_facts",
            [],
            |row| row.get(0),
        )?;
        let has_run_index = table_exists(conn, "run_index");
        let newest_run: i64 = if has_run_index {
            conn.query_row("SELECT COALESCE(MAX(rowid), 0) FROM run_index", [], |row| {
                row.get(0)
            })?
        } else {
            0
        };
        let stale = self.built_at.map_or(true, |built| {
            now.duration_since(built) >= FULL_REBUILD_INTERVAL
        });
        if stale || newest_fact < self.export_seq || newest_run < self.run_rowid {
            *self = Self {
                generation: self.generation + 1,
                built_at: Some(now),
                ..Self::default()
            };
        }

        let mut facts = conn.prepare_cached(
            "SELECT export_seq, run_id,
                    json_extract(segment_json, '$.session'),
                    CAST(json_extract(segment_json, '$.occurred_at_ms') AS INTEGER)
             FROM export_facts WHERE export_seq > ?1 ORDER BY export_seq",
        )?;
        let mut rows = facts.query(params![self.export_seq])?;
        while let Some(row) = rows.next()? {
            self.generation += 1;
            self.export_seq = self.export_seq.max(row.get(0)?);
            let Some(identity) = row.get::<_, Option<String>>(2)? else {
                continue;
            };
            let session = self.sessions.entry(identity).or_default();
            session.run_ids.insert(row.get(1)?);
            if let Some(activity) = row.get::<_, Option<i64>>(3)? {
                session.activity = Some(session.activity.map_or(activity, |a| a.max(activity)));
            }
        }
        drop(rows);

        if !has_run_index {
            self.open_runs.clear();
            return Ok(());
        }
        let open_before = self.open_runs_fingerprint();
        // Runs seen open last time: still open, and with what stamp?
        let mut by_rowid = conn.prepare_cached(
            "SELECT CASE WHEN json_valid(session) THEN json(session) END, state_changed_ms, state
             FROM run_index WHERE rowid = ?1",
        )?;
        let open: Vec<i64> = self.open_runs.keys().copied().collect();
        for rowid in open {
            let row = by_rowid
                .query_row(params![rowid], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .optional()?;
            match row {
                Some((identity, state_changed_ms, state)) if is_open(&state) => {
                    self.open_runs.insert(
                        rowid,
                        OpenRun {
                            identity,
                            state_changed_ms,
                            active: state == "active",
                        },
                    );
                }
                _ => {
                    self.open_runs.remove(&rowid);
                }
            }
        }
        let mut new_runs = conn.prepare_cached(
            "SELECT rowid, CASE WHEN json_valid(session) THEN json(session) END,
                    state_changed_ms, state
             FROM run_index WHERE rowid > ?1 ORDER BY rowid",
        )?;
        let mut rows = new_runs.query(params![self.run_rowid])?;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            self.run_rowid = self.run_rowid.max(rowid);
            let state: String = row.get(3)?;
            if is_open(&state) {
                self.open_runs.insert(
                    rowid,
                    OpenRun {
                        identity: row.get(1)?,
                        state_changed_ms: row.get(2)?,
                        active: state == "active",
                    },
                );
            }
        }
        if self.open_runs_fingerprint() != open_before {
            self.generation += 1;
        }
        Ok(())
    }

    fn open_runs_fingerprint(&self) -> Vec<(i64, Option<String>, Option<i64>, bool)> {
        let mut runs: Vec<_> = self
            .open_runs
            .iter()
            .map(|(rowid, run)| {
                (
                    *rowid,
                    run.identity.clone(),
                    run.state_changed_ms,
                    run.active,
                )
            })
            .collect();
        runs.sort_unstable();
        runs
    }

    /// The listed sessions (see `ranked`), reusing the last answer while
    /// nothing in the store changed.
    pub(super) fn list(&mut self, limit: usize) -> Vec<ListedSession> {
        if let Some((generation, cached_limit, listed)) = &self.list_memo {
            if *generation == self.generation && *cached_limit == limit {
                return listed.clone();
            }
        }
        let listed = self.ranked(limit);
        self.list_memo = Some((self.generation, limit, listed.clone()));
        listed
    }

    /// The `limit` most recently active sessions plus every session with a
    /// run in progress, newest first. A session's activity is the newest of
    /// its facts' `occurred_at_ms` and its active runs' `state_changed_ms`; a
    /// session with neither is not listed. Ties go to the smaller identity.
    fn ranked(&self, limit: usize) -> Vec<ListedSession> {
        let mut active: HashMap<&str, Option<i64>> = HashMap::new();
        for run in self.open_runs.values().filter(|run| run.active) {
            let Some(identity) = run.identity.as_deref() else {
                continue;
            };
            let stamp = active.entry(identity).or_insert(None);
            if let Some(changed) = run.state_changed_ms {
                *stamp = Some(stamp.map_or(changed, |s| s.max(changed)));
            }
        }
        let newest = |a: Option<i64>, b: Option<i64>| match (a, b) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        // (activity, identity, running) for every listable session. Built
        // from the index's own map without re-hashing every identity, since
        // a busy store holds tens of thousands of sessions.
        let mut ranked: Vec<(i64, &str, bool)> = Vec::with_capacity(self.sessions.len());
        for (identity, facts) in &self.sessions {
            let stamp = active.get(identity.as_str()).copied();
            if let Some(activity) = newest(facts.activity, stamp.flatten()) {
                ranked.push((activity, identity, stamp.is_some()));
            }
        }
        for (identity, stamp) in &active {
            if !self.sessions.contains_key(*identity) {
                if let Some(activity) = stamp {
                    ranked.push((*activity, identity, true));
                }
            }
        }
        let order =
            |a: &(i64, &str, bool), b: &(i64, &str, bool)| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1));
        if ranked.len() > limit {
            if limit > 0 {
                ranked.select_nth_unstable_by(limit - 1, order);
            }
            let tail = ranked.split_off(limit);
            ranked.extend(tail.into_iter().filter(|session| session.2));
        }
        ranked.sort_unstable_by(order);
        ranked
            .into_iter()
            .map(|(activity, identity, running)| ListedSession {
                identity: identity.to_owned(),
                activity,
                running,
            })
            .collect()
    }

    /// The run ids of the session's facts, for an indexed totals query.
    pub(super) fn run_ids(&self, identity: &str) -> Vec<String> {
        self.sessions
            .get(identity)
            .map(|facts| facts.run_ids.iter().cloned().collect())
            .unwrap_or_default()
    }
}
