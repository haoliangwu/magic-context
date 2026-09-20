//! Executes the production transform entry point against a real SQLite store.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest, TransformResponse};
use mc_store::McStore;
use serde_json::json;

fn descriptor(path: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "cold-flip-review".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.join("store.db").to_string_lossy().into(),
        },
    }
}

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:review",
        note_project_path: "git:review",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: true,
        now_ms: 0,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 16_000,
        protected_tokens_provenance: "derived",
        compaction_enabled: true,
        smart_drops: false,
        cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: Some("Today's date: Thu Jan 01 1970".into()),
        historian_active: false,
        wrapup_active: false,
    }
}

fn request(profile: &str) -> TransformRequest {
    serde_json::from_value(json!({
        "kind": "transform", "v": 2, "serializer_profile": profile,
        "session_id": "review", "render_config": "cfg0", "tool_present": false,
        "auto_search_enabled": false,
        "messages": (1..=8).map(|n| json!({
            "mid": format!("m{n}"), "ordinal": n,
            "ck": { "role": "user", "content": [{"kind": {"type": "text", "text": format!("message {n} {}", "stable prefix ".repeat(4096))}}],
                "meta": {"harness_id": format!("m{n}"), "created_at_ms": n * 600_000}}
        })).collect::<Vec<_>>()
    })).unwrap()
}

fn run(store: &McStore, request: &TransformRequest) -> TransformResponse {
    transform(store, request, &context()).unwrap()
}
fn bytes(response: &TransformResponse) -> Vec<u8> {
    serde_json::to_vec(response.messages()).unwrap()
}
fn tagged(response: &TransformResponse) -> bool {
    String::from_utf8(bytes(response)).unwrap().contains("§1§")
}
fn quiet(store: &McStore, request: &TransformRequest, expected: &[u8]) {
    for _ in 0..8 {
        let response = run(store, request);
        assert_ne!(response.action, "HARD", "quiet pass must not bust");
        assert_eq!(
            bytes(&response),
            expected,
            "quiet pass changed served bytes"
        );
    }
}

#[test]
fn dormant_flip_readd_and_restart_are_single_hard() {
    for profile in ["opencode-aisdk", "claude-code-anthropic"] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = McStore::open(&descriptor(dir.path())).unwrap();
        let mut request = request(profile);
        let dormant = run(&store, &request);
        assert_eq!(dormant.action, "HARD");
        assert!(!tagged(&dormant));
        quiet(&store, &request, &bytes(&dormant));
        for restart in [false, true] {
            if restart {
                drop(store);
                store = McStore::open(&descriptor(dir.path())).unwrap();
            }
            let before = store.load("review").unwrap();
            assert!(!before.meta.tagging_surface_active);
            request.tool_present = true;
            let transition = run(&store, &request);
            assert_eq!(transition.action, "HARD");
            assert!(
                tagged(&transition),
                "transition must serve tags immediately"
            );
            let wire = String::from_utf8(bytes(&transition)).unwrap();
            for n in 1..=8 {
                assert!(wire.contains(&format!("§{n}§")), "missing tag {n}");
            }
            let after = store.load("review").unwrap();
            assert_ne!(
                before.meta.last_render_config,
                after.meta.last_render_config
            );
            assert!(after.meta.tagging_surface_active);
            quiet(&store, &request, &bytes(&transition));
            drop(store);
            store = McStore::open(&descriptor(dir.path())).unwrap();
            quiet(&store, &request, &bytes(&transition));
            request.tool_present = false;
            let disabled = run(&store, &request);
            assert!(!tagged(&disabled));
            quiet(&store, &request, &bytes(&disabled));
        }
    }
}

#[test]
fn subagent_flip_records_action_and_stable_tagged_replay() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    request.is_subagent = true;
    let before = run(&store, &request);
    println!(
        "subagent initialized={} latch={} config={}",
        store.load("review").unwrap().meta.initialized,
        store.load("review").unwrap().meta.tagging_surface_active,
        store.load("review").unwrap().meta.last_render_config
    );
    request.tool_present = true;
    let transition = run(&store, &request);
    let replay = run(&store, &request);
    println!(
        "subagent: before={} transition={} replay={}, tags={}/{}/{}, bytes={}/{}/{}",
        before.action,
        transition.action,
        replay.action,
        tagged(&before),
        tagged(&transition),
        tagged(&replay),
        bytes(&before).len(),
        bytes(&transition).len(),
        bytes(&replay).len()
    );
    // This subagent never sets the store's initialized flag or commits a render
    // identity. Its SOFT+ label therefore does not mean it replayed a frozen prefix.
    assert!(!store.load("review").unwrap().meta.initialized);
    assert_eq!(before.action, "SOFT+");
    assert_eq!(transition.action, "SOFT+");
    assert!(!tagged(&before));
    assert!(tagged(&transition));
    assert_eq!(bytes(&transition), bytes(&replay));
    assert_ne!(replay.action, "HARD");
}

#[test]
fn temporal_quiet_active_session_does_not_invent_transition() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    request.tool_present = true;
    let first = run(&store, &request);
    assert_eq!(first.action, "HARD");
    assert!(tagged(&first));
    assert!(!serde_json::to_string(&store.load("review").unwrap().core)
        .unwrap()
        .contains("migration:renderer-transition"));
    quiet(&store, &request, &bytes(&first));
}

#[test]
fn lifecycle_cas_advances_do_not_repeat_surface_transition() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    run(&store, &request);
    request.tool_present = true;
    let transition = run(&store, &request);
    assert_eq!(transition.action, "HARD");
    assert_eq!(transition.row_version, 2);
    let core = serde_json::to_value(&store.load("review").unwrap().core).unwrap();
    assert!(core.to_string().contains("temporal_parity"));
    for n in 0..10 {
        let mut historian = store.load("review").unwrap().meta.historian;
        historian.last_no_fire = Some(format!("review observation {n}"));
        mc_module::historian::persist_historian_state(&store, "review", historian).unwrap();
    }
    assert_eq!(
        serde_json::to_value(&store.load("review").unwrap().core).unwrap(),
        core
    );
    assert_eq!(store.load("review").unwrap().row_version, Some(12));
    quiet(&store, &request, &bytes(&transition));
}

#[test]
fn identity_fold_without_temporal_parity_tags_on_the_same_hard() {
    for profile in ["opencode-aisdk", "claude-code-anthropic"] {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&descriptor(dir.path())).unwrap();
        let mut request = request(profile);
        for message in &mut request.messages {
            message.ck.meta.created_at_ms = None;
            message.ck.mark_modified();
        }
        let dormant = run(&store, &request);
        quiet(&store, &request, &bytes(&dormant));
        let old_identity = store.load("review").unwrap().meta.last_render_config;
        assert!(!old_identity.contains("tfe:"));
        request.tool_present = true;
        let transition = run(&store, &request);
        assert_eq!(transition.action, "HARD");
        assert!(tagged(&transition));
        let loaded = store.load("review").unwrap();
        assert!(loaded.meta.last_render_config.contains("tfe:4:tfe4"));
        assert!(!serde_json::to_string(&loaded.core)
            .unwrap()
            .contains("temporal_parity"));
        quiet(&store, &request, &bytes(&transition));
    }
}
