//! End-to-end acceptance test: the cache-stability transform driven THROUGH a live
//! subc daemon (a real ck-subc spawns mc-module as a provider, and a SubcConsumer
//! calls the `transform` op over the wire).
//!
//! Covered here (the cases drivable through the real production path): the first-pass
//! Hard fold, growing-tail and nonce-only defers (cached prefix byte-stable), an
//! epoch (render-config) Hard, a share-nothing boundary absence that degrades to raw
//! pending-rewrite pass-through, and a process restart replaying byte-identical. The m1
//! delta SOFT and the deferred-drop drain need a content/reducer producer not yet
//! built, so they are exercised in the library tests with stubbed inputs instead.

#![forbid(unsafe_code)]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerOptions, RetryBackoff, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MODULE_ID: &str = "magic-context";
// Cold daemon startup takes ~7s on an idle machine (measured); under CI or
// sibling-build load it can exceed 10s, which failed this suite spuriously.
const START_TIMEOUT: Duration = Duration::from_secs(60);

// ---- process lifecycle ----

struct LiveDaemon {
    child: Child,
    runtime_dir: PathBuf,
    config_dir: PathBuf,
    connection_file: PathBuf,
}

impl Drop for LiveDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.runtime_dir);
        let _ = fs::remove_dir_all(&self.config_dir);
    }
}

/// Owns the test's temp root. The daemon and every module process share the data home
/// under it, so cleanup cannot belong to any one of them: bind this first so it drops
/// last, after all of those processes have exited. A failing test keeps the root, since
/// the seeded store and the daemon's log are what a failed run needs for diagnosis.
struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

struct ModuleProcess {
    child: Child,
}

impl ModuleProcess {
    fn kill_and_wait(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ModuleProcess {
    fn drop(&mut self) {
        self.kill_and_wait();
    }
}

/// Uses a generated fixture and throwaway daemon/store; never connects to a live installation.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "set MC_SYNC_PROBE_FIXTURE to the scratch plugin page"]
async fn cereb_full_sync_through_real_daemon() {
    std::env::remove_var(subc_protocol::SUBC_MODULE_ID_ENV);
    std::env::remove_var(subc_protocol::SUBC_LAUNCH_NONCE_ENV);
    std::env::remove_var(subc_os::LAUNCH_NONCE_FD_ENV);
    let fixture =
        fs::read(std::env::var("MC_SYNC_PROBE_FIXTURE").expect("fixture required")).unwrap();
    let workspace = workspace_root();
    let subconscious = subconscious_root(&workspace);
    let daemon_bin = ensure_binary(
        &subconscious,
        subconscious.join("target/debug/ck-subc"),
        &["build", "-p", "subc-core", "--bins"],
    );
    let module_bin = ensure_binary(
        &workspace,
        workspace.join("target/debug/ck-mc"),
        &["build", "-p", "mc-module"],
    );
    let temp_root = TempRoot(unique_temp_dir("mc-full-sync-probe"));
    let runtime = temp_root.0.join("runtime");
    let config = temp_root.0.join("config");
    let data = temp_root.0.join("data");
    let projects = temp_root.0.join("projects");
    for dir in [&runtime, &data, &projects] {
        fs::create_dir_all(dir).unwrap();
    }
    PROJECT_BASE
        .set(fs::canonicalize(projects).unwrap())
        .unwrap();
    write_empty_config(&config);
    let daemon = spawn_daemon(&daemon_bin, &runtime, &config, &data);
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;
    let _module =
        spawn_module_with_differential(&module_bin, &daemon.connection_file, &data, false);
    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();
    wait_for_module_registration(&consumer, START_TIMEOUT).await;
    for pass in 0..3 {
        let mut page: Value = serde_json::from_slice(&fixture).unwrap();
        page["transform_page_id"] = json!(format!("daemon-probe-{pass}"));
        let encode_start = std::time::Instant::now();
        let bytes = serde_json::to_vec(&page).unwrap();
        let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let response = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: MODULE_ID.to_string(),
                },
                identity_for("ses"),
                bytes,
                fast_call_options(),
            )
            .await
            .unwrap();
        let round_trip_ms = start.elapsed().as_secs_f64() * 1000.0;
        let parse_start = std::time::Instant::now();
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        let parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(decoded["status"], "ok");
        println!("daemon-probe pass={pass} encode_ms={encode_ms:.3} round_trip_ms={round_trip_ms:.3} response_parse_ms={parse_ms:.3} response_bytes={} timings={}", response.len(), decoded["timings"]);
    }
    let logs = data.join("cortexkit/magic-context/logs");
    if let Ok(entries) = fs::read_dir(logs) {
        for entry in entries.flatten() {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                for line in text.lines().filter(|line| {
                    line.contains("mc-pass-timing") || line.contains("mc-transform-page-timing")
                }) {
                    println!("scratch-module-log {line}");
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mc_transform_spine_through_real_daemon() {
    // Clear any inherited supervision environment variables so this test opens the
    // real daemon as an ordinary client instead of reusing a reserved supervised
    // identity.
    std::env::remove_var(subc_protocol::SUBC_MODULE_ID_ENV);
    std::env::remove_var(subc_protocol::SUBC_LAUNCH_NONCE_ENV);
    std::env::remove_var(subc_os::LAUNCH_NONCE_FD_ENV);

    let workspace = workspace_root();
    let subconscious = subconscious_root(&workspace);

    // Build the daemon (from the sibling subconscious workspace) and our module.
    let daemon_bin = ensure_binary(
        &subconscious,
        subconscious.join("target/debug/ck-subc"),
        &["build", "-p", "subc-core", "--bins"],
    );
    let module_bin = ensure_binary(
        &workspace,
        workspace.join("target/debug/ck-mc"),
        &["build", "-p", "mc-module"],
    );

    // Declared before the daemon and modules so it drops after them.
    let temp_root = TempRoot(unique_temp_dir("mc-module-real-daemon"));
    let temp = temp_root.0.clone();
    let runtime_dir = temp.join("runtime");
    let config_dir = temp.join("config");
    let data_home = temp.join("data"); // store lands here (dev_descriptor → XDG_DATA_HOME)

    // Project roots live under the temp root so they are removed with it.
    let projects = temp.join("projects");
    fs::create_dir_all(&projects).unwrap();
    // Canonicalize so the seeded project_path matches the binding's project_root after
    // any path resolution in the daemon/on_bind (e.g. macOS /var → /private/var).
    PROJECT_BASE
        .set(fs::canonicalize(&projects).unwrap_or(projects))
        .expect("one real-daemon test per process sets the project base once");
    fs::create_dir_all(&runtime_dir).unwrap();
    fs::create_dir_all(&data_home).unwrap();
    write_empty_config(&config_dir);

    // Seed the store the spawned module will open. m0/m1 are composed FROM the store, so
    // the acceptance vectors need real compartments (a boundary) + memories. We open the
    // SAME descriptor the module computes, seed, then DROP the handle to release the
    // single-writer lease BEFORE spawning the module (which re-acquires it). This is the
    // production reality: the historian/dreamer write the store out of band; the module
    // reads it. No test-only wire surface.
    seed_store(&data_home);

    let daemon = spawn_daemon(&daemon_bin, &runtime_dir, &config_dir, &data_home);
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;

    let mut module = spawn_module(&module_bin, &daemon.connection_file, &data_home);

    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();

    // Module registration is asynchronous relative to our first route.open, and the
    // daemon's unknown_module is a terminal control-plane reject (route_retry only
    // covers transport failures). Under load the module's debug-build boot can lose
    // this race by tens of seconds, so poll registration with a bounded probe before
    // the first real call instead of relying on call-site retries.
    wait_for_module_registration(&consumer, START_TIMEOUT).await;

    // ===== PRODUCTION-PATH cases (session "spine"): m0/m1 composed FROM the seeded store.
    // The seed (seed_store) gave "spine" one compartment covering ordinals 1..=10 (end id
    // "m10", P1 "SUMMARY-1-10") and no memories. m0 is the compartment SUMMARY, the anchor
    // is "m10", and the raw covered message stays in the live array (trimmed from output). =====

    // bootstrap: the first pass folds Hard. m0 = the decay-rendered compartment summary.
    let r = call(
        &consumer,
        json!({
            "session_id": "spine", "render_config": "cfg0",
            "serializer_profile": "owned-llmrunner",
            "full_array_fingerprint": "fp-spine-bootstrap",
            "messages": [ck("m10", 10, "raw covered"), ck("t11", 11, "tail")]
        }),
    )
    .await;
    assert_eq!(r["status"], "ok");
    assert_eq!(r["served_from"], "transform");
    assert_eq!(r["full_array_fingerprint"], "fp-spine-bootstrap");
    assert_eq!(r["action"], "HARD", "bootstrap must fold Hard");
    assert_eq!(
        r["boundary_id"], "m10#0",
        "anchor = the compartment's end message id"
    );
    assert!(
        m0(&r).contains("SUMMARY-1-10"),
        "m0 is the summary: {}",
        m0(&r)
    );
    assert!(
        !m0(&r).contains("raw covered"),
        "m0 is NOT the raw covered bytes"
    );
    assert_eq!(m1(&r), M1_PLACEHOLDER);
    assert_eq!(
        tail_ids(&r),
        vec!["t11"],
        "covered raw msg trimmed, tail kept"
    );
    assert_eq!(r["committed"], true);

    let status = call_raw(
        &consumer,
        "spine",
        json!({ "kind": "status", "session_id": "spine" }),
    )
    .await;
    assert_eq!(status["ok"], true);
    assert_eq!(status["store_open"], true);
    assert_eq!(status["session_id"], "spine");
    assert_eq!(status["pass_trace"]["receive_count"], 1);
    assert_eq!(status["pass_trace"]["reject_count"], 0);
    assert!(
        status["pass_trace"]["last_completed_at_ms"]
            .as_i64()
            .unwrap()
            > 0
    );

    // growing-tail defers. Send the FULL live array each pass (the module locates the
    // boundary "m10" over it). Prefix blocks byte-identical; tail verbatim; no write.
    let mut prev_m0: Option<String> = None;
    for n in 11..=14u64 {
        let mut items = vec![ck("m10", 10, "raw covered")];
        for k in 11..=n {
            let bytes = if k == 11 {
                "tail".to_string()
            } else {
                format!("tail{k}")
            };
            items.push(ck(&format!("t{k}"), k, &bytes));
        }
        let d = call(
            &consumer,
            json!({ "session_id": "spine", "render_config": "cfg0", "messages": items }),
        )
        .await;
        assert_eq!(d["action"], "SOFT+", "defer must not bust");
        assert_eq!(
            d["committed"],
            json!(n > 11),
            "only first-seen tail mids persist identity vectors"
        );
        if let Some(p) = &prev_m0 {
            assert_eq!(&m0(&d), p, "m0 changed on defer over the wire");
        }
        let tail: Vec<String> = (11..=n).map(|k| format!("t{k}")).collect();
        assert_eq!(tail_ids(&d), tail, "tail must be verbatim live items");
        prev_m0 = Some(m0(&d));
    }

    // epoch-Hard: a render-config change rematerializes (m0 re-composed from the store).
    let e = call(
        &consumer,
        json!({
            "session_id": "spine", "render_config": "cfg1",
            "messages": [ck("m10", 10, "raw covered")]
        }),
    )
    .await;
    assert_eq!(e["action"], "HARD", "epoch change must fold Hard");
    assert!(m0(&e).contains("SUMMARY-1-10"));

    // A share-nothing boundary absence is not a safe re-cut target. It returns the raw
    // array, arms the pending-rewrite alarm, and leaves the held lineage intact.
    let rev = call(
        &consumer,
        json!({ "session_id": "spine", "render_config": "cfg1", "messages": [ck("z", 90, "other")] }),
    )
    .await;
    assert_eq!(
        rev["action"], "PASSTHROUGH",
        "share-nothing revert degrades raw"
    );
    assert_eq!(
        rev["reconcile_pending"], false,
        "pending raw traffic must not set reconcile"
    );
    assert_eq!(
        tail_ids(&rev),
        vec!["z"],
        "raw pass-through returns the live array"
    );

    // The boundary returns (m10 back in the array) → pending clears in a normal defer: it
    // writes once to clear the alarm but the prefix stays byte-identical (still SOFT+).
    let reconciled = call(
        &consumer,
        json!({ "session_id": "spine", "render_config": "cfg1", "messages": [ck("m10", 10, "raw covered")] }),
    )
    .await;
    assert_eq!(
        reconciled["action"], "SOFT+",
        "reconcile-clear is a defer, not a bust"
    );
    assert_eq!(reconciled["reconcile_pending"], false, "flag cleared");
    assert!(m0(&reconciled).contains("SUMMARY-1-10"), "m0 still frozen");

    // ===== memory folds into m0 from the store (session "soft"): the seed gave it the
    // same single compartment AND a memory (id 5, "a durable rule"), so the bootstrap HARD
    // composes m0 with that memory in the <project-memory> block. =====
    let boot = call(
        &consumer,
        json!({ "session_id": "soft", "render_config": "cfg0", "messages": [ck("m10", 10, "raw")] }),
    )
    .await;
    assert_eq!(boot["action"], "HARD");
    // the memory was seeded before the bootstrap HARD, so it is folded into m0.
    assert!(
        m0(&boot).contains("a durable rule"),
        "memory folded into m0: {}",
        m0(&boot)
    );

    // Native serving runs with the module's differential flag below, so both the cold full
    // encoder and the incremental path execute and byte-compare inside the real provider process.
    let native_request = json!({
        "session_id": "native",
        "render_config": "cfg0",
        "serializer_profile": "opencode-aisdk",
        "serve_native": true,
        "full_array_fingerprint": "fp-native",
        "messages": [ck("native-1", 1, "native tail")],
        "native_messages": [{
            "info": { "id": "native-1", "role": "user", "custom": "preserve" },
            "parts": [{ "type": "text", "text": "native tail" }]
        }]
    });
    let native_first = call(&consumer, native_request.clone()).await;
    assert_eq!(native_first["status"], "ok");
    assert_eq!(
        native_first["native_messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["info"]["custom"],
        "preserve"
    );
    let native_replay = call(&consumer, native_request).await;
    assert_eq!(native_replay["action"], "SOFT+");
    assert_eq!(
        native_replay["timings"]["native_cache_encoded_messages"], 0,
        "steady real-daemon native replay must encode no messages"
    );
    assert!(
        native_replay["timings"]["native_cache_reused_messages"]
            .as_u64()
            .unwrap_or_default()
            > 0
    );
    assert_eq!(
        native_replay["native_messages"], native_first["native_messages"],
        "real-daemon incremental native replay drifted"
    );

    // ===== restart the module and confirm byte-identical replay (spine session) =====
    module.kill_and_wait();
    drop(module);
    tokio::time::sleep(Duration::from_millis(200)).await; // OS releases the single-writer lease
    let _module2 = spawn_module(&module_bin, &daemon.connection_file, &data_home);
    // This module is started by hand, not supervised by the daemon, so between the
    // kill and the new registration the daemon has no module of this id and answers
    // `unknown_module`, which is terminal for route.open. Wait for the restarted
    // module to register, exactly as for the first spawn.
    wait_for_module_registration(&consumer, START_TIMEOUT).await;

    // replay the spine at the frozen baseline (boundary "m10" present) → pure defer, no write,
    // m0 reproduces byte-identical across the restart (the lineage baseline is durable).
    let after = call(
        &consumer,
        json!({ "session_id": "spine", "render_config": "cfg1", "messages": [ck("m10", 10, "raw covered")] }),
    )
    .await;
    assert_eq!(after["action"], "SOFT+", "restart must not bust");
    assert_eq!(after["committed"], false, "restart replay writes nothing");
    assert!(
        m0(&after).contains("SUMMARY-1-10"),
        "lineage m0 reproduces across restart"
    );

    drop(consumer);
    drop(daemon);
}

/// Seed the module's store before it opens (release the single-writer lease before spawn).
/// Mirrors the out-of-band historian/dreamer writers: "spine" gets one compartment (a
/// boundary), "soft" gets the same compartment plus a foldable memory.
fn seed_store(data_home: &Path) {
    use mc_store::{McStore, StoredCompartment};
    let descriptor = mc_module::dev_descriptor_at(&data_home.to_string_lossy());
    let store = McStore::open_for_test(&descriptor).expect("open store to seed");
    let c = |seq: i64, start: i64, end: i64, end_id: &str, p1: &str| StoredCompartment {
        sequence: seq,
        start_message: start,
        end_message: end,
        end_message_id: format!("{end_id}#0"),
        title: format!("C{seq}"),
        content: p1.to_string(),
        p1: Some(p1.to_string()),
        importance: 50,
        ..Default::default()
    };
    store
        .replace_compartments("spine", &[c(1, 1, 10, "m10", "SUMMARY-1-10")])
        .unwrap();
    store
        .replace_compartments("soft", &[c(1, 1, 10, "m10", "S")])
        .unwrap();
    // A memory under the "soft" session's project identity. The module resolves the project
    // from the route binding (the identity's project_root), so seed the memory under the
    // SAME deterministic project_root_for("soft") that identity_for() will bind for that
    // session — otherwise the module would read a different project's (empty) memory set.
    let proj = project_root_for("soft");
    store
        .seed_memory(5, &proj, "ARCHITECTURE", "a durable rule", 70)
        .unwrap();
    // The host records each session's project in context.db; the module keys the
    // session's memories by that record.
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                 VALUES ('soft', 'opencode', ?1, 1)",
                [&proj],
            )?;
            Ok(())
        })
        .unwrap();
    // drop `store` here → release the single-writer lease before the module spawns
}

// Reference the crate's constant rather than a local copy: this test's private
// duplicate went stale when the placeholder gained its <session-history-since>
// wrapper (TS-parity), and the drift only surfaces under the real-daemon env.
use mc_module::memory_render::M1_PLACEHOLDER;

fn ck(id: &str, ordinal: u64, bytes: &str) -> Value {
    json!({
        "mid": id,
        "ordinal": ordinal,
        "ck": {
            "role": "user",
            "content": [{ "kind": { "type": "text", "text": bytes } }],
            "meta": { "harness_id": id }
        }
    })
}

/// The m0 synthetic message bytes from a response's ck_messages.
fn m0(r: &Value) -> String {
    synthetic_bytes(r, 0)
}
fn m1(r: &Value) -> String {
    synthetic_bytes(r, 1)
}
fn synthetic_bytes(r: &Value, index: usize) -> String {
    let msg = r["ck_messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["meta"]["synthetic"] == json!(true))
        .nth(index)
        .unwrap_or_else(|| panic!("no synthetic message {index} in ck_messages: {r}"));
    msg["content"][0]["kind"]["text"]
        .as_str()
        .unwrap()
        .to_string()
}
/// The non-synthetic tail item ids, in order.
fn tail_ids(r: &Value) -> Vec<String> {
    r["ck_messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["meta"]["synthetic"] != json!(true))
        .map(|m| m["meta"]["harness_id"].as_str().unwrap_or("").to_string())
        .collect()
}
// ---- helpers (adapted from subc-client-rs/tests/real_daemon.rs) ----

async fn call(consumer: &SubcConsumer, mut body: Value) -> Value {
    // The handler dispatches on `kind`; tag the envelope as a v2 transform op and
    // supply the serializer profile all production transform requests must carry.
    if let Value::Object(map) = &mut body {
        map.insert("kind".to_string(), Value::String("transform".to_string()));
        map.entry("v".to_string()).or_insert_with(|| json!(2));
        map.entry("serializer_profile".to_string())
            .or_insert_with(|| Value::String("owned-llmrunner".to_string()));
    }
    let session = body
        .get("session_id")
        .and_then(Value::as_str)
        .expect("transform body carries session_id")
        .to_string();
    call_raw(consumer, &session, body).await
}

async fn call_raw(consumer: &SubcConsumer, session: &str, body: Value) -> Value {
    // Each logical session uses one stable consumer identity whose `session` matches the
    // request body's session_id. That keeps every call for that session on one consistent
    // daemon route, and the status/health requests reuse the same route on purpose.
    let bytes = consumer
        .call(
            RouteTarget::ToolProvider {
                module_id: MODULE_ID.to_string(),
            },
            identity_for(session),
            serde_json::to_vec(&body).unwrap(),
            fast_call_options(),
        )
        .await
        .unwrap_or_else(|e| panic!("module call failed: {e:?}"));
    serde_json::from_slice(&bytes).unwrap()
}

fn spawn_daemon(
    daemon_bin: &Path,
    runtime_dir: &Path,
    config_dir: &Path,
    data_home: &Path,
) -> LiveDaemon {
    let child = Command::new(daemon_bin)
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env("XDG_CONFIG_HOME", config_dir)
        // The daemon derives `cortexkit/run` (including `logs/`) from the data home, not
        // the runtime dir. Without this, a test daemon's log sink resolves to the host's
        // real `~/.local/share/cortexkit/run/logs/subc.log` and interleaves test boots
        // with production ones. Sharing the module's data home mirrors production layout.
        .env("XDG_DATA_HOME", data_home)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .env("HOME", config_dir)
        .env_remove(subc_protocol::SUBC_MODULE_ID_ENV)
        .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
        .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
        .env("SUBC_PORT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn daemon {}: {e}", daemon_bin.display()));
    LiveDaemon {
        child,
        runtime_dir: runtime_dir.to_path_buf(),
        config_dir: config_dir.to_path_buf(),
        connection_file: runtime_dir.join("subc-connection.json"),
    }
}

fn spawn_module(module_bin: &Path, connection_file: &Path, data_home: &Path) -> ModuleProcess {
    spawn_module_with_differential(module_bin, connection_file, data_home, true)
}

fn spawn_module_with_differential(
    module_bin: &Path,
    connection_file: &Path,
    data_home: &Path,
    differential: bool,
) -> ModuleProcess {
    let mut child = Command::new(module_bin)
        .arg("--subc")
        .arg(connection_file)
        .env(subc_protocol::SUBC_MODULE_ID_ENV, MODULE_ID)
        .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
        .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
        .env("XDG_DATA_HOME", data_home)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .env(
            "XDG_CONFIG_HOME",
            data_home.parent().unwrap().join("config"),
        )
        .env("HOME", data_home.parent().unwrap().join("config"))
        .env(
            "MC_NATIVE_ATTACHMENT_DIFFERENTIAL",
            if differential { "1" } else { "0" },
        )
        .env(
            "MC_PREFIX_PROJECTION_DIFFERENTIAL",
            if differential { "1" } else { "0" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn module {}: {e}", module_bin.display()));
    // The module logs to stderr; an undrained pipe fills its 64KB buffer and the module
    // BLOCKS on a stderr write mid-boot, so it never registers (observed as a spurious
    // unknown_module reject once boot logging grew past the buffer). Drain continuously
    // and forward so failures keep the module's log visible.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("mc-module: {line}");
            }
        });
    }
    ModuleProcess { child }
}

fn write_empty_config(config_dir: &Path) {
    fs::create_dir_all(config_dir.join("cortexkit")).unwrap();
    fs::write(
        config_dir.join("cortexkit").join("subc.jsonc"),
        serde_json::to_string_pretty(&json!({ "version": 1, "modules": {} })).unwrap(),
    )
    .unwrap();
}

fn fast_consumer_options() -> ConsumerOptions {
    ConsumerOptions {
        handshake_timeout: Duration::from_secs(2),
        // Debug-build module cold start under parallel cargo load can push the FIRST
        // transform (bootstrap HARD) past 10s; this suite gates correctness, not latency.
        call_timeout: Duration::from_secs(60),
        reconnect_backoff: RetryBackoff {
            base: Duration::from_millis(50),
            cap: Duration::from_millis(250),
            max_attempts: 40,
        },
        restored_debounce: Duration::from_millis(10),
        // Library default: this harness exercises route/store behavior, not
        // half-open socket detection.
        liveness_probe_window: ConsumerOptions::default().liveness_probe_window,
    }
}

fn fast_call_options() -> CallOptions {
    CallOptions {
        // See fast_consumer_options: first-call cold start under load needs headroom.
        timeout: Duration::from_secs(60),
        route_retry: RetryBackoff {
            base: Duration::from_millis(50),
            cap: Duration::from_millis(250),
            max_attempts: 60,
        },
        route_retry_deadline: Duration::from_secs(60),
        ..CallOptions::default()
    }
}

/// Base directory for project roots, set by the test under its `TempRoot` so the roots
/// are removed with it.
static PROJECT_BASE: OnceLock<PathBuf> = OnceLock::new();

/// A DETERMINISTIC project_root per session, shared by `identity_for` (the route binding)
/// and `seed_store` (the memory's project_path) so the module resolves the SAME project a
/// seeded memory was written under.
fn project_root_for(session: &str) -> String {
    let base = PROJECT_BASE
        .get()
        .expect("the test sets PROJECT_BASE before resolving a project root");
    let p = base.join(session);
    fs::create_dir_all(&p).unwrap();
    p.to_string_lossy().to_string()
}

/// One stable BindIdentity per logical session: repeated calls for the same session reuse
/// the SAME (target, identity) route (one on_bind), the production "one route per session"
/// shape. The project_root is the deterministic `project_root_for(session)` so seeds match.
fn identity_for(session: &str) -> BindIdentity {
    static REG: OnceLock<Mutex<std::collections::HashMap<String, BindIdentity>>> = OnceLock::new();
    let reg = REG.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut map = reg.lock().unwrap();
    map.entry(session.to_string())
        .or_insert_with(|| {
            BindIdentity::new(
                PathBuf::from(project_root_for(session)),
                "mc-module-test",
                session,
            )
        })
        .clone()
}

async fn wait_for_module_registration(consumer: &SubcConsumer, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let probe = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: MODULE_ID.to_string(),
                },
                identity_for("registration-probe"),
                serde_json::to_vec(&serde_json::json!({ "kind": "status", "v": 1 })).unwrap(),
                fast_call_options(),
            )
            .await;
        match probe {
            Ok(_) => return,
            Err(err) => {
                let text = format!("{err:?}");
                if !text.contains("unknown_module") {
                    // Registered (or a different failure the real calls will surface) —
                    // registration itself is no longer the blocker.
                    return;
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("module did not register with the daemon within {wait:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_connection_file(path: &Path, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if path.exists() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon did not write {} within {wait:?}", path.display());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn ensure_binary(manifest_dir: &Path, path: PathBuf, cargo_args: &[&str]) -> PathBuf {
    static BUILD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = BUILD_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let output = Command::new("cargo")
        .env("CARGO_BUILD_JOBS", "2")
        .args(cargo_args)
        .current_dir(manifest_dir)
        .output()
        .unwrap_or_else(|e| panic!("failed to run cargo {cargo_args:?}: {e}"));
    assert!(
        output.status.success(),
        "cargo {cargo_args:?} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(path.exists(), "expected binary at {}", path.display());
    path
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

fn subconscious_root(workspace: &Path) -> PathBuf {
    fs::canonicalize(workspace.parent().unwrap().join("subconscious")).unwrap()
}

fn unique_temp_dir(name: &str) -> PathBuf {
    let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{name}-{}-{nonce}", std::process::id()))
}

/// Run with `cargo test --locked -p mc-module --test real_daemon mc_pipe_only_supervision_through_real_daemon -- --exact --nocapture`.
/// Uses a supervised production binary and a test-owned runner in temporary directories.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mc_pipe_only_supervision_through_real_daemon() {
    use std::os::unix::fs::PermissionsExt;
    use subc_protocol::manifest::{
        Concurrency, ManagementOperation, ManagementOperationKind, ModuleManifest, ProviderRole,
    };

    let workspace = workspace_root();
    let subconscious = subconscious_root(&workspace);
    let revision = Command::new("git")
        .current_dir(&subconscious)
        .args(["merge-base", "--is-ancestor", "2b0914f0", "HEAD"])
        .status()
        .unwrap();
    assert!(revision.success(), "local subconscious must include 2b0914f0 (per-module launch_nonce_env); refusing to pull or modify it");
    // Build artifacts stay under this worktree, even for the subconscious source.
    let target = workspace.join("target/pipe-only-subc");
    let daemon_bin = ensure_binary(
        &subconscious,
        target.join("debug/ck-subc"),
        &[
            "build",
            "--locked",
            "-p",
            "subc-core",
            "--bins",
            "--target-dir",
            target.to_str().unwrap(),
        ],
    );
    let module_bin = ensure_binary(
        &workspace,
        workspace.join("target/debug/ck-mc"),
        &["build", "--locked", "-p", "mc-module"],
    );
    let temp = TempRoot(unique_temp_dir("mc-pipe-only-daemon"));
    let runtime = temp.0.join("runtime");
    let config = temp.0.join("config");
    let data = temp.0.join("data");
    let project = temp.0.join("project");
    for dir in [&runtime, &data, &project] {
        fs::create_dir_all(dir).unwrap();
    }
    write_empty_config(&config);
    provision_context_store(&workspace, &config, &data);
    let environment = temp.0.join("child-environment.txt");
    let launcher = temp.0.join("launch-mc.sh");
    // Record presence, not the secret. exec preserves the actual inherited pipe
    // and makes the observed environment the environment of ck-mc itself.
    fs::write(&launcher, format!("#!/bin/sh\nif [ -z \"${{SUBC_LAUNCH_NONCE+x}}\" ]; then echo env_absent; else echo env_present; fi > '{}'\nif [ -n \"${{SUBC_LAUNCH_NONCE_FD+x}}\" ]; then echo fd_present; else echo fd_absent; fi >> '{}'\nexec '{}' \"$@\"\n", environment.display(), environment.display(), module_bin.display())).unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        config.join("cortexkit/subc.jsonc"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "modules": { MODULE_ID: {
                "program": launcher, "args": [], "enabled": true, "reserved": true,
                "launch_nonce_env": false,
                "env": { "XDG_DATA_HOME": data, "XDG_CONFIG_HOME": config, "HOME": config }
            }}
        }))
        .unwrap(),
    )
    .unwrap();
    let daemon = spawn_daemon(&daemon_bin, &runtime, &config, &data);
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;
    let stop_module = StopSupervisedModule {
        ck_bin: target.join("debug/ck"),
        daemon: &daemon,
        data_home: data.clone(),
    };
    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();
    let identity = BindIdentity::new(
        fs::canonicalize(&project).unwrap(),
        "claude-code",
        "pipe-only",
    );
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let probe = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: MODULE_ID.into(),
                },
                identity.clone(),
                br#"{"kind":"status","v":1}"#.to_vec(),
                fast_call_options(),
            )
            .await;
        if let Ok(bytes) = probe {
            let status: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(status["ok"], true, "{status}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "supervised HELLO did not register"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        fs::read_to_string(&environment).unwrap(),
        "env_absent\nfd_present\n"
    );
    let ck_bin = target.join("debug/ck");
    let provenance = Command::new(&ck_bin)
        .args([
            "--subc",
            daemon.connection_file.to_str().unwrap(),
            "--json",
            "provenance",
            MODULE_ID,
        ])
        .env("HOME", &config)
        .env("XDG_CONFIG_HOME", &config)
        .env("XDG_DATA_HOME", &data)
        .env("XDG_RUNTIME_DIR", &runtime)
        .output()
        .unwrap();
    assert!(
        provenance.status.success(),
        "{}",
        String::from_utf8_lossy(&provenance.stderr)
    );
    let provenance: Value = serde_json::from_slice(&provenance.stdout).unwrap();
    assert_eq!(
        provenance["modules"][0]["module_declared"]["build"]["launch_nonce_source"], "fd",
        "{provenance}"
    );

    // Broca is a management-surface provider. Record the principal the daemon
    // supplies in route.bind, then require a historian request on that route:
    // observing a bind proposal alone would not prove the open was accepted.
    let (observed_tx, mut observed_rx) = tokio::sync::mpsc::unbounded_channel();
    let manifest = ModuleManifest::builder("broca", "0.0.0")
        .provides(vec![ProviderRole::ManagementSurface {
            operations: vec![ManagementOperation {
                name: "session.send".into(),
                kind: ManagementOperationKind::Query,
                description: None,
            }],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![],
            concurrency: Concurrency::ModuleManaged,
        }])
        .build();
    let (runner, serving) = subc_client_rs::serve_with_handle(
        &daemon.connection_file,
        manifest,
        CensusRunner {
            observed: observed_tx,
            principals: Mutex::new(std::collections::HashMap::new()),
        },
    )
    .await
    .unwrap();
    let serving = tokio::spawn(serving);
    let messages: Vec<_> = (1..=80)
        .map(|n| {
            ck(
                &format!("m{n}"),
                n,
                &format!("message {n} {}", "word ".repeat(800)),
            )
        })
        .collect();
    let bytes = consumer.call(RouteTarget::ToolProvider { module_id: MODULE_ID.into() }, identity,
        serde_json::to_vec(&json!({ "kind": "transform", "v": 2, "session_id": "pipe-only", "render_config": "cfg0", "serializer_profile": "owned-llmrunner", "historian_model_chain": ["anthropic/claude-sonnet-4"], "messages": messages })).unwrap(), fast_call_options()).await.unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["status"], "ok", "{response}");
    assert_eq!(response["served_from"], "transform", "{response}");
    assert_eq!(
        response["historian"]["fired"], true,
        "{}",
        response["historian"]
    );
    let (principal, request) = tokio::time::timeout(START_TIMEOUT, observed_rx.recv())
        .await
        .expect("historian route never carried traffic")
        .unwrap();
    assert_eq!(
        principal,
        Some(subc_protocol::Principal::Reserved {
            module_id: MODULE_ID.into()
        })
    );
    assert_eq!(request["method"], "session.send");
    drop(runner);
    serving.abort();
    let _ = serving.await;
    drop(consumer);
    drop(stop_module);
    drop(daemon);
}

#[cfg(unix)]
struct CensusRunner {
    observed: tokio::sync::mpsc::UnboundedSender<(Option<subc_protocol::Principal>, Value)>,
    principals: Mutex<std::collections::HashMap<u16, Option<subc_protocol::Principal>>>,
}

#[cfg(unix)]
#[async_trait::async_trait]
impl subc_client_rs::ModuleHandler for CensusRunner {
    async fn on_bind(
        &self,
        req: &subc_client_rs::RouteBindRequest,
    ) -> subc_client_rs::BindDecision {
        self.principals
            .lock()
            .unwrap()
            .insert(req.handle.channel, req.principal.clone());
        subc_client_rs::BindDecision::accept()
    }

    async fn handle(
        &self,
        ctx: subc_client_rs::RequestCtx,
        body: Vec<u8>,
    ) -> subc_client_rs::HandlerOutcome {
        let principal = self
            .principals
            .lock()
            .unwrap()
            .get(&ctx.route_handle().channel)
            .cloned()
            .unwrap();
        self.observed
            .send((principal, serde_json::from_slice(&body).unwrap()))
            .unwrap();
        // The received request and its daemon-supplied principal prove the
        // route was accepted; no completion or external provider is needed.
        subc_client_rs::HandlerOutcome::Response(
            serde_json::to_vec(
                &json!({ "error": "hermetic census runner does not execute completions" }),
            )
            .unwrap(),
        )
    }
}

// Disable the supervised child before the daemon is killed, including on panic.
// Otherwise daemon teardown could leave a restarted child behind the test.
#[cfg(unix)]
struct StopSupervisedModule<'a> {
    ck_bin: PathBuf,
    daemon: &'a LiveDaemon,
    data_home: PathBuf,
}

#[cfg(unix)]
impl Drop for StopSupervisedModule<'_> {
    fn drop(&mut self) {
        let _ = Command::new(&self.ck_bin)
            .args([
                "--subc",
                self.daemon.connection_file.to_str().unwrap(),
                "module",
                "stop",
                MODULE_ID,
            ])
            .env("HOME", &self.daemon.config_dir)
            .env("XDG_CONFIG_HOME", &self.daemon.config_dir)
            .env("XDG_RUNTIME_DIR", &self.daemon.runtime_dir)
            .env("XDG_DATA_HOME", &self.data_home)
            .env_remove(subc_protocol::SUBC_MODULE_ID_ENV)
            .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
            .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
            .output();
    }
}

/// Provision through the public CLI before starting ck-mc, without an OpenCode or Pi
/// session creating context.db first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hostless_store_init_first_transform_through_real_daemon() {
    let workspace = workspace_root();
    let subconscious = subconscious_root(&workspace);
    let target = workspace.join("target/store-init-subc");
    let daemon_bin = ensure_binary(
        &subconscious,
        target.join("debug/ck-subc"),
        &[
            "build",
            "--locked",
            "-j",
            "2",
            "-p",
            "subc-core",
            "--bin",
            "ck-subc",
            "--target-dir",
            target.to_str().unwrap(),
        ],
    );
    let module_bin = PathBuf::from(env!("CARGO_BIN_EXE_ck-mc"));
    let parent = std::env::temp_dir().join("magic-context/store-init");
    fs::create_dir_all(&parent).unwrap();
    let temp = TempRoot(parent.join(format!(
        "daemon-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    )));
    let runtime = temp.0.join("runtime");
    let config = temp.0.join("config");
    let data = temp.0.join("data");
    let project = temp.0.join("project");
    for dir in [&runtime, &data, &project] {
        fs::create_dir_all(dir).unwrap();
    }
    write_empty_config(&config);
    let context_path = data.join("cortexkit/magic-context/context.db");
    assert!(!context_path.exists());
    provision_context_store(&workspace, &config, &data);
    assert!(
        context_path.exists(),
        "doctor store init must create context.db"
    );
    let daemon = spawn_daemon(&daemon_bin, &runtime, &config, &data);
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;
    let _module =
        spawn_module_with_differential(&module_bin, &daemon.connection_file, &data, false);
    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();
    let identity = BindIdentity::new(project, "mc-module-test", "hostless");
    let target = RouteTarget::ToolProvider {
        module_id: MODULE_ID.to_string(),
    };
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let probe = consumer
            .call(
                target.clone(),
                identity.clone(),
                serde_json::to_vec(&json!({"kind":"status", "v":1})).unwrap(),
                fast_call_options(),
            )
            .await;
        if !matches!(&probe, Err(e) if format!("{e:?}").contains("unknown_module")) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "module did not register"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let bytes = consumer.call(target, identity, serde_json::to_vec(&json!({
        "kind": "transform", "v": 2, "serializer_profile": "owned-llmrunner",
        "session_id": "hostless", "render_config": "cfg0", "full_array_fingerprint": "fp-hostless",
        "messages": [ck("first", 1, "hello")]
    })).unwrap(), fast_call_options()).await.unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        response["status"], "ok",
        "first transform failed: {response}"
    );
    let store = rusqlite::Connection::open_with_flags(
        data.join("cortexkit/magic-context/store.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let version: i64 = store
        .query_row(
            "SELECT version FROM cortexkit_schema_version WHERE namespace = 'mc_cache' AND version = 61",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 61);
    let stamp: String = store
        .query_row(
            "SELECT single_store_set_by FROM mc_privilege_state WHERE id = 1 AND single_store = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        stamp.ends_with("+fresh"),
        "unexpected fresh marker: {stamp}"
    );
    let context = rusqlite::Connection::open_with_flags(
        context_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (state, by): (String, String) = context
        .query_row(
            "SELECT state, migrated_by FROM single_store_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "migrated");
    assert_eq!(by, stamp);
}

// Production modules require an existing host-schema store before opening storage.
// Provision it through the CLI in the test's isolated roots, just as setup does.
fn provision_context_store(workspace: &Path, config: &Path, data: &Path) {
    let output = Command::new("bun")
        .args([
            "run",
            "packages/cli/src/index.ts",
            "doctor",
            "store",
            "init",
        ])
        .current_dir(workspace)
        .env("HOME", config)
        .env("XDG_CONFIG_HOME", config)
        .env("XDG_DATA_HOME", data)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .output()
        .expect("bun must be installed to provision the host-schema store");
    assert!(
        output.status.success(),
        "store init failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Replay host-wire fixtures against a caller-provided pair of cloned stores.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MC_PLANNING_CLONE, MC_PLANNING_FIXTURES, MC_PLANNING_MODULE and MC_PLANNING_DAEMON"]
async fn planning_clones_through_real_daemon() {
    let root = PathBuf::from(std::env::var_os("MC_PLANNING_CLONE").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("magic-context/perf-planning")
    ));
    let fixtures: Vec<Value> = serde_json::from_slice(
        &fs::read(std::env::var_os("MC_PLANNING_FIXTURES").unwrap()).unwrap(),
    )
    .unwrap();
    let runtime = root.join("runtime");
    let config = root.join("config");
    let data = root.join("data");
    let project = root.parent().unwrap().join("replay-project");
    for dir in [&runtime, &project] {
        fs::create_dir_all(dir).unwrap();
    }
    PROJECT_BASE.set(project.canonicalize().unwrap()).unwrap();
    write_empty_config(&config);
    let daemon = spawn_daemon(
        &PathBuf::from(std::env::var_os("MC_PLANNING_DAEMON").unwrap()),
        &runtime,
        &config,
        &data,
    );
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;
    let module = spawn_module_with_differential(
        &PathBuf::from(std::env::var_os("MC_PLANNING_MODULE").unwrap()),
        &daemon.connection_file,
        &data,
        true,
    );
    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();
    wait_for_module_registration(&consumer, START_TIMEOUT).await;
    for pid in [daemon.child.id(), module.child.id()] {
        let output = Command::new("lsof")
            .args(["-p", &pid.to_string()])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        let db_lines: Vec<_> = text.lines().filter(|line| line.contains(".db")).collect();
        for line in &db_lines {
            assert!(
                line.contains(root.to_str().unwrap()),
                "non-clone database opened: {line}"
            );
        }
        println!("planning-lsof pid={pid}: {}", db_lines.join("\n"));
    }
    for fixture in fixtures {
        let session = fixture["session_id"].as_str().unwrap();
        let mut request = fixture.clone();
        let raw = request
            .as_object_mut()
            .unwrap()
            .remove("raw_messages")
            .unwrap();
        let raw = raw.as_array().unwrap();
        let mut decoded = mc_module::codec::decode_opencode(raw).messages;
        for (message, native) in decoded.iter_mut().zip(raw) {
            message.ordinal = native["absolute_ordinal"].as_u64().unwrap();
            message.ck.meta.ordinal = Some(message.ordinal);
        }
        request["messages"] = serde_json::to_value(decoded).unwrap();
        request["native_messages"] = serde_json::to_value(raw).unwrap();
        request["serve_native"] = json!(true);
        let mut previous_served = Vec::new();
        for pass in 0..15 {
            if let Ok(delay) = std::env::var("MC_PLANNING_DELAY_MS") {
                tokio::time::sleep(Duration::from_millis(delay.parse().unwrap())).await;
            }
            request["nonce"] = json!(pass);
            let response = call(&consumer, request.clone()).await;
            assert_eq!(response["status"], "ok", "{response}");
            println!(
                "planning-clone session={session} pass={pass} action={} timings={} historian={}",
                response["action"], response["timings"], response["historian"]
            );
            assert!(
                response["native_messages"].is_array(),
                "probe must compare the actual native served output"
            );
            let served = serde_json::to_vec(&json!({"ck_messages": response["ck_messages"], "native_messages": response["native_messages"]})).unwrap();
            if pass > 0 && pass % 3 != 0 {
                assert_eq!(
                    served, previous_served,
                    "nonce-only defer must replay identical served bytes"
                );
            }
            fs::write(root.join(format!("{session}-{pass}-served.json")), &served).unwrap();
            previous_served = served;
            fs::write(
                root.join(format!("{session}-{pass}-response.json")),
                serde_json::to_vec(&response).unwrap(),
            )
            .unwrap();
            if pass >= 2 {
                assert_eq!(
                    response["action"], "SOFT+",
                    "fixture must reach managed defer"
                );
            }
            if pass % 3 == 2 {
                let messages = request["messages"].as_array_mut().unwrap();
                let ordinal = messages.last().unwrap()["ordinal"].as_u64().unwrap() + 1;
                let id = format!("planning-delta-{pass}");
                let text = "Read-only performance replay: continue the implementation and run the targeted verification.";
                messages.push(ck(&id, ordinal, text));
                request["native_messages"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({
                        "info": {"id": id, "role": "user"},
                        "parts": [{"type": "text", "text": text}]
                    }));
            }
        }
    }
}
