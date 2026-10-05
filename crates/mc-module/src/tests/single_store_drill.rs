//! The post-migration drill: the module serving a real, migrated `store.db`/`context.db`
//! pair.
//!
//! Ignored by default because it needs a migrated copy of a real pair. Run it with
//! `MC_DRILL_DIR` naming a directory that holds the migrated `store.db` and `context.db`
//! (never the live stores) and `MC_DRILL_PROJECT` naming a project identity with memories:
//!
//! ```text
//! MC_DRILL_DIR=$TMPDIR/magic-context/<task>/drill MC_DRILL_PROJECT=git:<root> \
//!   cargo test -p mc-module --lib single_store_drill -- --ignored --nocapture
//! ```
//!
//! It opens the pair through the production path (`McStore::open`, then the fenced
//! `context.db` attach), creates one session, applies to it the cache reset the migration
//! applies to every session, and then drives the passes the migration promises: one `Hard`
//! whose reason is the project memory epoch, then three defers with byte-identical output.

use super::*;

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs a migrated specimen copy named by MC_DRILL_DIR"]
async fn single_store_drill_post_migration_passes() {
    let dir = PathBuf::from(std::env::var("MC_DRILL_DIR").expect("MC_DRILL_DIR"));
    let project_identity = std::env::var("MC_DRILL_PROJECT").expect("MC_DRILL_PROJECT");
    let store_path = dir.join("store.db");
    let context_path = dir.join("context.db");
    let descriptor = StorageDescriptor {
        module_id: "magic-context".to_string(),
        storage_namespace: "magic-context".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: store_path.to_string_lossy().into_owned(),
        },
    };

    // The writer epoch lives in the lease file next to the live store, which a specimen
    // copy does not carry, so a fresh open here claims a lower epoch than the one the
    // copied fence row records. Clear the fence of this throwaway copy so this process
    // may write, as the live module's own lease would allow.
    rusqlite::Connection::open(&store_path)
        .unwrap()
        .execute("DELETE FROM cortexkit_fence", [])
        .unwrap();
    let store = Arc::new(McStore::open(&descriptor).expect("a migrated store opens"));
    single_store_reads::attach(&store, &context_path).expect("context.db attaches");
    let handler = McHandler::with_producer_factory_config_resolver(
        Arc::new(TestProducerFactory {
            state: Arc::new(ProducerState::default()),
        }),
        default_test_config(),
        Arc::new(MissingSessionResolver),
    );
    handler.store.set(Arc::clone(&store)).ok().unwrap();
    let root = dir.join("drill-project-root");
    std::fs::create_dir_all(&root).unwrap();
    let root_text = root.to_str().unwrap();
    store.set_route_identity_for_test(root_text, &project_identity);
    handler.bind_route(7, binding(root_text, "ses"));

    let messages = || {
        vec![
            ck("m0", 0, "drill opening request"),
            ck_with_role("m1", 1, "assistant", "drill answer"),
            ck("m2", 2, "drill follow-up"),
        ]
    };
    let first =
        call_transform_request(&handler, request_with_usage(messages(), 1_000, 50_000)).await;
    println!(
        "DRILL warm action={} reason={} rendered_memory_ids={}",
        first["action"],
        first["materialize_reason"],
        first["rendered_memory_ids"].as_array().map_or(0, Vec::len)
    );

    // The migration's cache reset, exactly as the engine applies it to every session.
    let reset = rusqlite::Connection::open(&store_path).unwrap();
    let reset_rows =
        mc_store::single_store_schema::reset_cache_state_for_single_store(&reset).unwrap();
    drop(reset);
    println!("DRILL cache reset rows={reset_rows}");

    let hard =
        call_transform_request(&handler, request_with_usage(messages(), 1_000, 50_000)).await;
    println!(
        "DRILL pass1 action={} reason={} rendered_memory_ids={}",
        hard["action"],
        hard["materialize_reason"],
        hard["rendered_memory_ids"].as_array().map_or(0, Vec::len)
    );
    assert_eq!(hard["decision"], "HARD", "{hard}");
    assert_eq!(hard["materialize_reason"], "project_memory_epoch");

    let mut served = Vec::new();
    for pass in 2..=4 {
        let response =
            call_transform_request(&handler, request_with_usage(messages(), 1_000, 50_000)).await;
        println!(
            "DRILL pass{pass} action={} scheduler={} digest={}",
            response["action"],
            response["scheduler_decision"],
            sha256_hex(response["ck_messages"].to_string().as_bytes())
        );
        assert_eq!(response["scheduler_decision"], "defer", "{response}");
        served.push(response["ck_messages"].to_string());
    }
    assert!(
        served.windows(2).all(|pair| pair[0] == pair[1]),
        "the three defers must be byte-identical"
    );
    assert_eq!(
        served[0],
        hard["ck_messages"].to_string(),
        "the defers replay the HARD's bytes"
    );
}
