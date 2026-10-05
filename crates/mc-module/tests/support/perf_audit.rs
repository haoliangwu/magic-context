//! Library-only instrument: run under an outer timeout with --release --lib --ignored --nocapture --test-threads=1.
//! All fixture paths are temporary. No host service or live store is opened.
use crate::{
    config::ConfigCache,
    host_store::{FenceState, HostStore, BUILT_CONTEXT_FENCE_VERSION},
    project_identity::ProjectIdentityResolver,
    reply_pages::accepts_reply_pages,
};
use mc_store::ContextDomain;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

#[test]
fn dated_search_reaches_hits_beyond_each_corpus_limit() {
    use crate::memory_tool::{search_available_corpora_for_session, MemorySearchOptions};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let dir = tempfile::tempdir().unwrap();
    let store = mc_store::McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context-test".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    store.with_context_conn_for_test(|tx| {
        for i in 0..102 {
            // The oldest match is exactly on both inclusive endpoints. All 101 newer
            // matches are outside the date range but would fill the SQL candidate cap.
            let date = if i == 0 { 1000 } else { 2000 };
            let content = format!("literal_100% needle {i}");
            tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES ('p','ARCHITECTURE',?1,?2,?3,?3,?3,?3)", params![content,format!("hash{i}"),date])?;
            tx.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES ('s',?1,?1,?1,'summary',?2,?3)", params![i+1,content,date])?;
            tx.execute("INSERT INTO notes(type,project_path,session_id,content,status,created_at,updated_at) VALUES ('smart','p','s',?1,'active',?2,?2)", params![content,date])?;
        }
        Ok(())
    }).unwrap();
    // Undated candidate identities and ordering come from the original queries,
    // independently of the implementation of inclusive date bounds.
    let query = "literal_100% needle";
    assert_eq!(
        store
            .search_visible_memory_contents("p", query)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        (2..=101).collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .search_compartments_like("s", query)
            .unwrap()
            .iter()
            .map(|r| r.sequence)
            .collect::<Vec<_>>(),
        (3..=102).rev().collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .search_notes_like("p", "s", query)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        (3..=102).rev().collect::<Vec<_>>()
    );
    let excluded = std::collections::BTreeSet::new();
    let options = MemorySearchOptions {
        limit: 100,
        include_memories: true,
        include_messages: true,
        include_notes: true,
        excluded_memory_ids: &excluded,
        from_ms: Some(1000),
        to_ms: Some(1000),
    };
    let hits =
        search_available_corpora_for_session(&store, "p", "s", "literal_100% needle", options)
            .unwrap();
    assert_eq!(
        hits.len(),
        3,
        "each corpus must filter dates before LIMIT 100"
    );
    assert!(hits.iter().all(|hit| hit.snippet.contains("needle 0")));
}

fn timed(mut f: impl FnMut(), rounds: usize) -> f64 {
    f();
    let start = Instant::now();
    for _ in 0..rounds {
        f();
    }
    start.elapsed().as_secs_f64() * 1000.0 / rounds as f64
}

#[test]
#[ignore = "performance instrument; uses throwaway databases"]
fn measure_module_findings() {
    for messages in [1_000, 10_000, 60_000] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        mc_store::single_store_domain::create_test_context_db(&path).unwrap();
        let mut conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut tag = tx.prepare("INSERT INTO tags(session_id,message_id,type,byte_size,tag_number,token_count,entry_fingerprint) VALUES ('s',?1,'text',512,?2,128,?1)").unwrap();
            for i in 0..messages {
                tag.execute(params![format!("m{i}"), i + 1]).unwrap();
            }
        }
        tx.commit().unwrap();
        let fingerprint_ms = timed(
            || {
                black_box(FenceState::read(&conn, &path, BUILT_CONTEXT_FENCE_VERSION).unwrap());
            },
            20,
        );
        let mut writer = HostStore::open(&path).unwrap();
        let context_tx_ms = timed(
            || {
                writer
                    .with_domain_transaction(&["memories"], &mut |tx| {
                        tx.execute("UPDATE memories SET seen_count=seen_count WHERE id=-1", [])?;
                        Ok(())
                    })
                    .unwrap();
            },
            20,
        );
        let domain = crate::single_store_reads::ModuleContextDomain::open(&path).unwrap();
        let scalar_reads_ms = timed(
            || {
                std::thread::scope(|scope| {
                    for _ in 0..4 {
                        scope.spawn(|| {
                            for _ in 0..10 {
                                domain
                                    .read(&mut |conn| {
                                        let max: i64 = conn.query_row(
                                            "SELECT MAX(tag_number) FROM tags WHERE session_id='s'",
                                            [],
                                            |r| r.get(0),
                                        )?;
                                        assert_eq!(max, messages);
                                        Ok(())
                                    })
                                    .unwrap();
                            }
                        });
                    }
                });
            },
            10,
        ) / 40.0;
        let body = serde_json::to_vec(&serde_json::json!({"accept_reply_pages":true,"messages":(0..messages).map(|i|serde_json::json!({"id":format!("m{i}"),"text":"Read the code and adjust the dependency. ".repeat(8)})).collect::<Vec<_>>() })).unwrap();
        let reply_parse_ms = timed(
            || {
                assert!(accepts_reply_pages(&body));
            },
            20,
        );
        let reply_hash_ms = timed(
            || {
                black_box(Sha256::digest(&body));
            },
            20,
        );
        let user = dir.path().join("magic-context.json");
        std::fs::write(&user, "{\"context_limit\":200000}").unwrap();
        let mut config = ConfigCache::default();
        let config_ms = timed(
            || {
                black_box(config.effective_for_paths(&user, dir.path()));
            },
            100,
        );
        let resolver = ProjectIdentityResolver::default();
        let identity_ms = timed(
            || {
                black_box(resolver.resolve(dir.path()).unwrap());
            },
            100,
        );
        println!("RS fixture messages={messages} RS1_fingerprint_ms={fingerprint_ms:.3} context_write_tx_ms={context_tx_ms:.3} RS6_4_thread_scalar_read_ms={scalar_reads_ms:.3} RS7_body_bytes={} RS7_parse_ms={reply_parse_ms:.3} RS7_sha_ms={reply_hash_ms:.3} RS9_config_ms={config_ms:.3} RS12_cached_identity_ms={identity_ms:.3}",body.len());
    }
}
