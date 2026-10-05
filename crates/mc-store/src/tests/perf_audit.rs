//! Isolated measuring instruments, not wall-clock assertions. Run with:
//! timeout 1200 cargo test --locked -p mc-store --release perf_audit -- --ignored --nocapture --test-threads=1
use super::*;
use std::hint::black_box;

fn timed(mut f: impl FnMut(), rounds: usize) -> f64 {
    f();
    let start = Instant::now();
    for _ in 0..rounds {
        f();
    }
    start.elapsed().as_secs_f64() * 1000.0 / rounds as f64
}

#[test]
fn fact_probes_preserve_exact_dedup_and_highest_watermark_across_batches() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let mut facts: Vec<_> = (0..260)
        .map(|i| FactCandidate {
            category: "ARCHITECTURE".into(),
            content: format!("fact {i}"),
            importance: Some(50),
            source_session_id: None,
            expires_at: None,
        })
        .collect();
    facts.push(facts[0].clone());
    facts.push(FactCandidate {
        content: " fact 0 ".into(),
        ..facts[0].clone()
    });
    store.context_write(context_writes::HISTORY_TABLES, |tx| {
        let promoted = promote_facts_tx(tx,"p",&facts,100)?;
        assert_eq!(promoted.len(),261);
        assert_eq!(promoted.last().unwrap().content," fact 0 ");
        let watermark: (i64,i64) = tx.query_row("SELECT written_memory_id,updated_at FROM memory_embedding_watermarks WHERE project_path='p'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(watermark,(promoted.last().unwrap().memory_id,100));
        assert!(promote_facts_tx(tx,"p",&facts,200)?.is_empty());
        let unchanged: (i64,i64) = tx.query_row("SELECT written_memory_id,updated_at FROM memory_embedding_watermarks WHERE project_path='p'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(unchanged,watermark);
        // Archived duplicates remain eligible for promotion; other projects do not dedup.
        tx.execute("UPDATE memories SET status='archived' WHERE content='fact 0'",[])?;
        assert_eq!(promote_facts_tx(tx,"p",&facts[..1],300)?.len(),1);
        assert_eq!(promote_facts_tx(tx,"other",&facts[..1],300)?.len(),1);
        Ok(())
    }).unwrap();
}

#[test]
fn fold_upsert_and_replace_preserve_retained_row_ids_and_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let rows: Vec<_> = (1..=10)
        .map(|i| StoredCompartment {
            sequence: i,
            start_message: i * 20,
            end_message: i * 20 + 19,
            start_message_id: format!("m{}#0", i * 20),
            end_message_id: format!("m{}#0", i * 20 + 19),
            content: format!("summary {i}"),
            p1: Some(format!("full tier {i}")),
            importance: 50,
            created_at: i,
            ..Default::default()
        })
        .collect();
    store.replace_compartments("s", &rows).unwrap();
    let read = || {
        store.context_read(|conn| {
        conn.prepare("SELECT id,sequence,content,p1 FROM compartments WHERE session_id='s' ORDER BY sequence")?
            .query_map([], |r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
    }).unwrap()
    };
    let before = read();
    let mut changed = rows[9].clone();
    changed.content = "revised summary".into();
    let mut appended = changed.clone();
    appended.sequence = 11;
    appended.start_message = 220;
    appended.end_message = 239;
    let fold = context_writes::PendingContextWrite::Fold(context_writes::FoldWrite {
        project_path: "p".into(),
        harness: None,
        compartments: vec![changed.clone(), appended.clone()],
        facts: Vec::new(),
        promote_facts: false,
        published_at_ms: 20,
        events: Vec::new(),
        primer_candidates: Vec::new(),
        user_memory_candidates: Vec::new(),
    });
    store
        .context_write(context_writes::HISTORY_TABLES, |tx| {
            context_writes::perf_apply_pending(tx, "s", &fold)?;
            Ok(())
        })
        .unwrap();
    let after = read();
    assert_eq!(&after[..9], &before[..9]);
    assert_eq!(after[9].0, before[9].0);
    assert_eq!(after[9].2, "revised summary");
    store
        .context_write(context_writes::HISTORY_TABLES, |tx| {
            context_writes::perf_apply_pending(tx, "s", &fold)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(read(), after);
    store
        .replace_compartments("s", &[changed, appended])
        .unwrap();
    assert_eq!(read(), after[9..]);
}

// Independent oracle: the previous oldest-first eviction algorithm, including the
// raw-only placeholder exception and repeated total queries.
fn legacy_evict(tx: &rusqlite::Transaction<'_>, session: &str) -> rusqlite::Result<()> {
    let empty = compress_transcript("").unwrap();
    loop {
        let total: i64 = tx.query_row("SELECT COALESCE(SUM(LENGTH(transcript_deflate)),0) FROM mc_chunk_transcripts WHERE session_id=?1",params![session],|r|r.get(0))?;
        if total <= MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES {
            return Ok(());
        }
        let victim: Option<(i64,bool)> = tx.query_row("SELECT compartment_seq, raw_messages_deflate IS NOT NULL FROM mc_chunk_transcripts WHERE session_id=?1 AND (raw_messages_deflate IS NULL OR transcript_deflate<>?2) ORDER BY created_at_ms,compartment_seq LIMIT 1",params![session,&empty],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((seq, raw)) = victim else {
            return Ok(());
        };
        if raw {
            tx.execute("UPDATE mc_chunk_transcripts SET transcript_deflate=?3 WHERE session_id=?1 AND compartment_seq=?2",params![session,seq,&empty])?;
        } else {
            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id=?1 AND compartment_seq=?2",
                params![session, seq],
            )?;
        }
    }
}

#[test]
fn prepared_transcripts_and_eviction_preserve_payloads_and_victim_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let transcript = "A summary with 雪 and §42§.\n";
    let raw = r#"[{"role":"user","text":"raw 雪","unknown":{"keep":true}}]"#;
    let prepared = prepare_chunk_transcripts(Some(transcript), Some(raw))
        .unwrap()
        .unwrap();
    assert_eq!(
        prepared.transcript,
        compress_transcript(transcript).unwrap()
    );
    assert_eq!(
        prepared.raw_messages.as_ref().unwrap(),
        &compress_raw_messages(raw).unwrap()
    );
    assert_eq!(
        decompress_raw_messages(prepared.raw_messages.as_ref().unwrap()).unwrap(),
        raw
    );
    let raw_only = prepare_chunk_transcripts(None, Some(raw)).unwrap().unwrap();
    assert_eq!(raw_only.transcript, compress_transcript("").unwrap());
    assert_eq!(raw_only.raw_messages, prepared.raw_messages);
    store.inner.with_conn(|conn| {
        let tx = rusqlite::Transaction::new_unchecked(conn,rusqlite::TransactionBehavior::Immediate)?;
        // Length, ordering and retention are the eviction inputs. Oversized fixture
        // blobs also exercise corrupt/legacy rows without requiring a new encoding.
        for session in ["legacy","optimized"] {
            for seq in 0..80 {
                tx.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,raw_messages_deflate,created_at_ms) VALUES (?1,?2,?2,?2,zeroblob(262144),?3,?4)",params![session,seq,if seq%3==0 {prepared.raw_messages.as_deref()}else{None},seq%5])?;
            }
            tx.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,raw_messages_deflate,created_at_ms) VALUES (?1,999,999,999,?2,?3,-1)",params![session,&raw_only.transcript,raw_only.raw_messages.as_deref()])?;
        }
        legacy_evict(&tx,"legacy")?;
        evict_chunk_transcripts_tx(&tx,"optimized")?;
        type TranscriptRows = Vec<(i64, Vec<u8>, Option<Vec<u8>>)>;
        let read = |session| -> rusqlite::Result<TranscriptRows> {
            tx.prepare("SELECT compartment_seq,transcript_deflate,raw_messages_deflate FROM mc_chunk_transcripts WHERE session_id=?1 ORDER BY compartment_seq")?
                .query_map(params![session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect()
        };
        assert_eq!(read("optimized")?,read("legacy")?);
        let raw_count: i64 = tx.query_row("SELECT COUNT(*) FROM mc_chunk_transcripts WHERE session_id='optimized' AND raw_messages_deflate IS NOT NULL",[],|r|r.get(0))?;
        assert_eq!(raw_count,28);
        tx.rollback()
    }).unwrap();
}

#[test]
#[ignore = "performance instrument; uses throwaway databases"]
fn measure_store_findings() {
    let baseline_dir = tempfile::tempdir().unwrap();
    let baseline = open_sqlite(&descriptor(baseline_dir.path())).unwrap();
    baseline
        .with_conn(|conn| {
            println!(
                "upstream store.db open policy: journal={} synchronous={}",
                conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))?,
                conn.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))?
            );
            Ok(())
        })
        .unwrap();
    for messages in [1_000, 10_000, 60_000] {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        let compartments: Vec<_> = (0..messages / 20)
            .map(|i| StoredCompartment {
                sequence: i + 1,
                start_message: i * 20,
                end_message: i * 20 + 19,
                start_message_id: format!("m{}#0", i * 20),
                end_message_id: format!("m{}#0", i * 20 + 19),
                title: format!("Work on subsystem {i}"),
                content: "Read the code, adjust a dependency, run tests. ".repeat(40),
                p1: Some("Full summary. ".repeat(100)),
                p2: Some("Short summary. ".repeat(20)),
                importance: 50,
                created_at: i,
                ..Default::default()
            })
            .collect();
        store.with_context_conn_for_test(|tx| {
            for row in &compartments {
                insert_compartment_tx(tx, "s", row.sequence, row, "opencode")?;
            }
            let mut insert = tx.prepare("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES ('p','ARCHITECTURE',?1,?2,1,1,?3,1)")?;
            for i in 0..messages / 10 {
                insert.execute(params![format!("memory {i}: architecture detail {}", "detail ".repeat(30)), format!("hash{i}"), i])?;
            }
            Ok(())
        }).unwrap();
        let core = CoreState {
            frozen_units: (0..messages)
                .map(|i| FrozenUnit {
                    key: format!("drop:m{i}#0"),
                    kind: "drop".into(),
                    frozen_payload: format!("[dropped §{}§]", i + 1),
                    durability_class: DurabilityClass::Lineage,
                    reset_rule: String::new(),
                })
                .collect(),
            ..Default::default()
        };
        let meta = ModuleMeta {
            resolved_compartment_boundaries: compartments
                .iter()
                .map(|row| {
                    let (start_id, start_block) =
                        context_boundaries::canonical_boundary_parts(&row.start_message_id)
                            .unwrap();
                    let (end_id, end_block) =
                        context_boundaries::canonical_boundary_parts(&row.end_message_id).unwrap();
                    let mut boundary = ResolvedContextBoundary {
                        sequence: row.sequence,
                        source_start_message: row.start_message,
                        source_end_message: row.end_message,
                        source_start_message_id: start_id.to_string(),
                        source_end_message_id: end_id.to_string(),
                        source_start_block_index: start_block,
                        source_end_block_index: end_block,
                        source_row_identity: String::new(),
                        start_message: row.start_message,
                        end_message: row.end_message,
                        start_message_id: row.start_message_id.clone(),
                        end_message_id: row.end_message_id.clone(),
                        start_date: None,
                        end_date: None,
                    };
                    boundary.bind_to_row(row).unwrap();
                    boundary
                })
                .collect(),
            ..Default::default()
        };
        let mut version = store.commit("s", None, &core, &meta).unwrap();
        let encode_ms = timed(
            || {
                version = store.commit("s", Some(version), &core, &meta).unwrap();
            },
            5,
        );
        let boundary_cold = Instant::now();
        black_box(store.cached_context_boundaries("s").unwrap());
        let boundary_cold_ms = boundary_cold.elapsed().as_secs_f64() * 1000.0;
        let boundary_warm_ms = timed(
            || {
                black_box(store.cached_context_boundaries("s").unwrap());
            },
            20,
        );
        let mut tail = compartments.last().unwrap().clone();
        tail.sequence += 1;
        let fold = context_writes::PendingContextWrite::Fold(context_writes::FoldWrite {
            project_path: "p".into(),
            harness: Some("opencode".into()),
            compartments: vec![tail],
            facts: Vec::new(),
            promote_facts: false,
            published_at_ms: 10,
            events: Vec::new(),
            primer_candidates: Vec::new(),
            user_memory_candidates: Vec::new(),
        });
        let fold_ms = timed(
            || {
                store
                    .context_write(context_writes::HISTORY_TABLES, |tx| {
                        let start = Instant::now();
                        context_writes::perf_apply_pending(tx, "s", &fold)?;
                        black_box(start.elapsed());
                        Ok(())
                    })
                    .unwrap();
            },
            20,
        );
        let mut serialization_fold = fold.clone();
        if let context_writes::PendingContextWrite::Fold(write) = &mut serialization_fold {
            write.compartments = vec![write.compartments[0].clone(); 8];
        }
        let pending_serialize_ms = timed(
            || {
                black_box(serde_json::to_string(&serialization_fold).unwrap());
                black_box(serde_json::to_string(&serialization_fold).unwrap());
            },
            20,
        );
        let memory_reads_ms = timed(
            || {
                for id in 1..=50 {
                    black_box(store.get_memory_full(id).unwrap().expect("seeded memory"));
                }
            },
            20,
        );
        let facts = vec![FactCandidate {
            category: "ARCHITECTURE".into(),
            content: "memory 0: architecture detail ".to_string() + &"detail ".repeat(30),
            importance: Some(50),
            source_session_id: None,
            expires_at: None,
        }];
        let facts_ms = timed(
            || {
                store
                    .context_write(context_writes::HISTORY_TABLES, |tx| {
                        black_box(promote_facts_tx(tx, "p", &facts, 10)?);
                        Ok(())
                    })
                    .unwrap();
            },
            20,
        );
        let search_ms = timed(
            || {
                black_box(store.search_visible_memory_contents("p", "memory").unwrap());
            },
            20,
        );
        let small_core = CoreState::default();
        let small_meta = ModuleMeta::default();
        let seeded_tags: Vec<_> = (0..messages)
            .map(|i| TagMintInput {
                block_id: format!("seed{i}#0"),
                kind: "message".into(),
                token_count: 32,
                source_bytes: vec![b'x'; 128],
            })
            .collect();
        store.mint_or_get_tags("tags", &seeded_tags, 1).unwrap();
        let mut tag_version = None;
        let mut tag_round = 0;
        let tag_commit_ms = timed(
            || {
                let mints: Vec<_> = (0..8)
                    .map(|i| McTagRow {
                        tag_number: 0,
                        block_id: format!("tag{}#{i}", tag_round),
                        kind: "message".into(),
                        token_count: 32,
                        created_at_ms: 1,
                        source_bytes: vec![b'x'; 128].into(),
                    })
                    .collect();
                tag_version = Some(
                    store
                        .commit_transform(
                            "tags",
                            TransformCommit {
                                expected: tag_version,
                                core: &small_core,
                                meta: &small_meta,
                                sections: Default::default(),
                                consumed_drop_ids: &[],
                                first_applied_command_ids: &[],
                                memory_revision: None,
                                compartment_max_seq: None,
                                project_root: None,
                                first_divergence: None,
                                scheduler_observation: None,
                                scheduler_request_observed_at_ms: None,
                                scheduler_full_array_fingerprint: None,
                                scheduler_eligible_supersession_count: None,
                                scheduler_withheld_by_tag_window: None,
                                scheduler_withheld_by_exempt_message: None,
                                scheduler_applied_supersession_count: None,
                                scheduler_applied_reductions: false,
                                overlays: TransformOverlayBatch {
                                    max_seen_ordinal: None,
                                    tag_mints: &mints,
                                    temporal_marks: &[],
                                    rewrite_temporal_marks: false,
                                    user_hint: None,
                                    channel1_append: None,
                                    created_at_ms: 1,
                                },
                            },
                        )
                        .unwrap(),
                );
                tag_round += 1;
            },
            20,
        );
        let assembly_ms = timed(
            || {
                black_box(store.load_historian_assembly_snapshot("s").unwrap());
            },
            20,
        );
        let canonical_ms = timed(
            || {
                for _ in 0..4 {
                    black_box(std::fs::canonicalize(dir.path()).unwrap());
                }
            },
            20,
        );
        let transcript = (0..messages)
            .map(|i| {
                format!(
                    "user m{i}: read src/module_{}.rs and fix issue {}\n",
                    i % 97,
                    i % 173
                )
            })
            .collect::<String>();
        let raw = serde_json::to_string(&(0..messages).map(|i| serde_json::json!({"id":format!("m{i}"),"role":"user","text":format!("Read module {} and investigate issue {}",i%97,i%173)})).collect::<Vec<_>>()).unwrap();
        let prepare_start = Instant::now();
        let prepared = prepare_chunk_transcripts(Some(&transcript), Some(&raw)).unwrap();
        let prepare_ms = prepare_start.elapsed().as_secs_f64() * 1000.0;
        let (codec_ms, schema_ms, transcript_ms, transcript_bytes) = store.inner.with_conn(|conn| {
            let transaction = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
            let codec_ms = timed(|| { black_box(cache_codec::read_decoded(&transaction, "s").unwrap()); }, 20);
            let schema_ms = timed(|| {
                let names: Vec<String> = transaction.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
                for name in names {
                    black_box(transaction.prepare(&format!("PRAGMA table_info(\"{}\")", name.replace('"', "\"\""))).unwrap().query_map([], |r| r.get::<_,String>(1)).unwrap().map(Result::unwrap).collect::<Vec<_>>());
                }
            }, 10);
            let transcript_ms = timed(|| { insert_prepared_chunk_transcripts_tx(&transaction, "s", 1, &compartments[..compartments.len().min(8)], prepared.as_ref()).unwrap(); }, 5);
            let bytes: i64 = transaction.query_row("SELECT SUM(LENGTH(transcript_deflate)+COALESCE(LENGTH(raw_messages_deflate),0)) FROM mc_chunk_transcripts WHERE session_id='s'", [], |r| r.get(0))?;
            let tiny_raw = compress_raw_messages("[0]").unwrap();
            for session in ["legacy_perf","optimized_perf"] {
                let mut insert = transaction.prepare("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,raw_messages_deflate,created_at_ms) VALUES (?1,?2,?2,?2,zeroblob(4096),?3,?2)")?;
                for seq in 0..compartments.len() {
                    insert.execute(params![session,seq as i64, if seq%3==0 {Some(tiny_raw.as_slice())}else{None}])?;
                }
            }
            let started = Instant::now(); legacy_evict(&transaction,"legacy_perf")?;
            let legacy_ms = started.elapsed().as_secs_f64()*1000.0;
            let started = Instant::now(); evict_chunk_transcripts_tx(&transaction,"optimized_perf")?;
            let optimized_ms = started.elapsed().as_secs_f64()*1000.0;
            println!("RS3 eviction rows={} 4096_bytes_per_row legacy_ms={legacy_ms:.3} single_scan_ms={optimized_ms:.3}",compartments.len());
            transaction.rollback()?;
            println!("RS3 messages={messages} prepare_outside_lock_ms={prepare_ms:.3}");
            Ok((codec_ms, schema_ms, transcript_ms, bytes))
        }).unwrap();
        println!("RS fixture messages={messages} compartments={} memories={} fold_context_tx_ms={fold_ms:.3} facts_context_tx_ms={facts_ms:.3} RS13_search_ms={search_ms:.3} RS8_commit_8_mints_ms={tag_commit_ms:.3} RS10_snapshot_ms={assembly_ms:.3} RS15_canonicalize_4_roots_ms={canonical_ms:.3} RS15_memory_reads_50_ms={memory_reads_ms:.3} RS15_serialize_twice_8_compartments_ms={pending_serialize_ms:.3} RS4_codec_ms={codec_ms:.3} RS4_commit_ms={encode_ms:.3} RS5_cold_ms={boundary_cold_ms:.3} RS5_warm_ms={boundary_warm_ms:.3} RS15_schema_ms={schema_ms:.3} RS3_write_8_store_tx_ms={transcript_ms:.3} RS3_persisted_bytes={transcript_bytes}", compartments.len(), messages/10);
    }
}
