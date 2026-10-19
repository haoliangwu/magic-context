//! Read historian counts and model attempts from context.db. The Rust module's tests compile
//! these same readers to verify its records can populate the dashboard's Historian tab.

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct SubagentInvocation {
    pub id: i64,
    pub session_id: String,
    pub harness: String,
    pub subagent: String,
    pub task: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub error: Option<String>,
    pub parent_invocation_id: Option<i64>,
}

pub fn get_subagent_invocations(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SubagentInvocation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, harness, subagent, task, provider_id, model_id,
                started_at, ended_at, status, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, error, parent_invocation_id
         FROM subagent_invocations
         WHERE session_id = ?1
         ORDER BY started_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SubagentInvocation {
            id: row.get(0)?,
            session_id: row.get(1)?,
            harness: row.get(2)?,
            subagent: row.get(3)?,
            task: row.get(4)?,
            provider_id: row.get(5)?,
            model_id: row.get(6)?,
            started_at: row.get(7)?,
            ended_at: row.get(8)?,
            status: row.get(9)?,
            input_tokens: row.get(10)?,
            output_tokens: row.get(11)?,
            cache_read_tokens: row.get(12)?,
            cache_write_tokens: row.get(13)?,
            error: row.get(14)?,
            parent_invocation_id: row.get(15)?,
        })
    })?;
    rows.collect()
}

pub fn count_historian_runs(conn: &Connection, session_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM historian_runs WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

#[cfg(test)]
mod historian_runs_reader_tests {
    use super::*;

    #[test]
    fn counts_recorded_runs_for_only_the_requested_session() {
        let conn = Connection::open_in_memory().expect("open test database");
        assert_eq!(count_historian_runs(&conn, "session-a"), 0);
        conn.execute_batch(
            "CREATE TABLE historian_runs (session_id TEXT NOT NULL);
             INSERT INTO historian_runs (session_id) VALUES ('session-a'), ('session-b'), ('session-a');",
        ).expect("create historian run fixture");
        assert_eq!(count_historian_runs(&conn, "session-a"), 2);
        assert_eq!(count_historian_runs(&conn, "session-b"), 1);
        assert_eq!(count_historian_runs(&conn, "session-c"), 0);
    }
}

#[cfg(test)]
mod subagent_invocation_reader_tests {
    use super::*;

    #[test]
    fn reads_stored_provider_and_preserves_missing_provider() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE subagent_invocations (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                subagent TEXT NOT NULL,
                task TEXT,
                provider_id TEXT,
                model_id TEXT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                status TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                error TEXT,
                parent_invocation_id INTEGER
             );
             INSERT INTO subagent_invocations VALUES
                (1, 'session', 'pi', 'historian', NULL, 'openai', 'gpt-6.1-sol', 10, 20, 'completed', 100, 20, 50, 5, NULL, NULL),
                (2, 'session', 'pi', 'historian', NULL, NULL, 'gemini-3.8-flash', 30, 40, 'completed', 200, 30, 80, 8, NULL, NULL);",
        ).unwrap();
        let rows = get_subagent_invocations(&conn, "session").unwrap();
        let openai = rows
            .iter()
            .find(|row| row.model_id.as_deref() == Some("gpt-6.1-sol"))
            .unwrap();
        let missing = rows
            .iter()
            .find(|row| row.model_id.as_deref() == Some("gemini-3.8-flash"))
            .unwrap();
        assert_eq!(openai.provider_id.as_deref(), Some("openai"));
        assert_eq!(missing.provider_id, None);
    }
}
