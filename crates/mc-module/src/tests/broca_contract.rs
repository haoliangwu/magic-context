//! The contract a Broca-hosted session relies on before the transform is switched on
//! for it. `docs/architecture/broca-transform-contract.md` is the prose half; these
//! tests pin the parts a caller caches: the facade tool array it declares once per
//! session, and what the transform serves on the first and second send under the
//! `owned-broca` serializer profile.

use super::*;

/// The facade tools a Broca mason may declare. `transform` is a module tool too, but
/// only Broca's transform plane calls it; a model must never see it.
const BROCA_FACADE_TOOL_NAMES: [&str; 5] = [
    "ctx_reduce",
    "ctx_memory",
    "ctx_expand",
    "ctx_search",
    "ctx_note",
];

/// Set this variable to rewrite the golden files from the current module output.
const BLESS_ENV: &str = "MC_BLESS_BROCA_FACADE_GOLDENS";

fn golden_path(preset: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(format!("broca-facade-tools-{preset}.json"))
}

async fn served_facade_tools(handler: &McHandler, preset: &str) -> Value {
    let response = call_dispatch_request(
        handler,
        json!({
            "kind": "manifest.get",
            "session_id": "ses",
            "preset": preset,
        }),
    )
    .await;
    assert_eq!(
        response["ok"],
        json!(true),
        "manifest.get failed: {response}"
    );
    assert_eq!(response["served_preset"], json!(preset));
    assert_eq!(response["preset_fallback"], json!(false));
    response["tools"].clone()
}

fn tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .expect("tools must be an array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect()
}

/// The served definitions are compared both as JSON values and as the exact pretty
/// bytes, so a reordered schema key fails here too: providers cache on bytes.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_arrays_match_the_per_preset_goldens() {
    for preset in ["full", "light"] {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        let served = served_facade_tools(&handler, preset).await;
        let served_bytes = format!("{}\n", serde_json::to_string_pretty(&served).unwrap());
        let path = golden_path(preset);
        if std::env::var_os(BLESS_ENV).is_some() {
            std::fs::write(&path, &served_bytes).unwrap();
            continue;
        }
        let golden_bytes = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let golden: Value = serde_json::from_str(&golden_bytes).unwrap();
        assert_eq!(
            served,
            golden,
            "served {preset} facade tools drifted from {}; a changed tool array busts every \
             Broca session's cached prefix, so update the golden only on purpose (set {BLESS_ENV}=1)",
            path.display()
        );
        assert_eq!(
            served_bytes,
            golden_bytes,
            "served {preset} facade tool bytes drifted from {}",
            path.display()
        );
        assert_eq!(tool_names(&served), BROCA_FACADE_TOOL_NAMES);
    }
}

/// The array does not depend on anything a caller might vary between sessions except the
/// preset: `memory.enabled` does not hide `ctx_memory`, the dreamer-only `ctx_memory_list`
/// never appears, and the startup manifest carries the same full-preset definitions plus
/// the internal `transform` tool.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_array_ignores_memory_config_and_matches_the_startup_manifest() {
    let full_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("full")).unwrap()).unwrap();
    let light_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("light")).unwrap()).unwrap();
    assert_eq!(tool_names(&full_golden), tool_names(&light_golden));
    assert_ne!(full_golden, light_golden, "light must differ only in prose");

    let mut memory_off = default_test_config();
    memory_off.memory_enabled = false;
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), memory_off);
    for (preset, golden) in [("full", &full_golden), ("light", &light_golden)] {
        let served = served_facade_tools(&handler, preset).await;
        assert_eq!(
            &served, golden,
            "memory.enabled=false changed the {preset} array"
        );
    }

    let startup = serde_json::to_value(manifest(DEFAULT_MODULE_ID)).unwrap();
    let startup_tools =
        find_tools_array(&startup["provides"]).expect("startup manifest declares a tool provider");
    let startup_names = startup_tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(startup_names.contains(&"transform"));
    assert!(!startup_names.contains(&"ctx_memory_list"));
    let startup_facades = startup_tools
        .iter()
        .filter(|tool| tool["name"] != json!("transform"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(Value::Array(startup_facades), full_golden);
}

/// Find the first `tools` array under a serialized manifest value, whatever the role
/// enum's serde tagging looks like.
fn find_tools_array(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Object(fields) => fields
            .get("tools")
            .and_then(Value::as_array)
            .or_else(|| fields.values().find_map(find_tools_array)),
        Value::Array(items) => items.iter().find_map(find_tools_array),
        _ => None,
    }
}

#[test]
fn legacy_bridge_startup_ctx_reduce_schema_bytes_are_pinned() {
    // subc-mcp tools/list copies the startup manifest's schema unchanged into
    // inputSchema. Pin those bytes, not tool.catalog's structural digest: the
    // Claude Code gateway (thalamus-core tool_surface.rs,
    // canonical_ctx_reduce_schema) checks this exact shape before it arms
    // reduction, and refuses a schema it does not recognise. Adding the `drop`
    // description on 2026-09-22 left Claude Code without reduction for nine
    // days without any error. Any change here must be coordinated with the
    // gateway owner first.
    let startup = serde_json::to_value(manifest(DEFAULT_MODULE_ID)).unwrap();
    let tools = find_tools_array(&startup["provides"]).unwrap();
    let reduce = tools
        .iter()
        .find(|tool| tool["name"] == "ctx_reduce")
        .unwrap();
    let expected = br#"{"additionalProperties":false,"properties":{"drop":{"description":"Tag IDs to drop: \"3-5\", \"1,2,9\", \"1-5,8,12-15\".","type":"string"}},"required":["drop"],"type":"object"}"#;
    assert_eq!(
        serde_json::to_vec(&reduce["schema"]).unwrap(),
        expected,
        "changing the startup reduce schema can silently disarm Claude Code reduction"
    );
}

/// Build one request exactly as Broca's transform plane sends it: the `owned-broca`
/// profile, the profile folded into `render_config`, and the fields the module does not
/// read today (`agent_drop_ids`, `cache_ttl_ms`) left in so the test sends the real shape.
fn broca_transform_request(messages: &[CkIngressMessage], input_tokens: u64) -> Value {
    json!({
        "kind": "transform",
        "v": 1,
        "serializer_profile": "owned-broca",
        "session_id": "ses",
        "render_config": "owned-broca\u{241f}rc-contract",
        "messages": messages,
        "usage": {
            "current_total_input_tokens": input_tokens,
            "context_limit_tokens": 200_000,
        },
        "cache_ttl_ms": 300_000,
        "agent_drop_ids": [],
    })
}

fn served_messages(response: &Value) -> Vec<Value> {
    assert_eq!(
        response["status"],
        json!("ok"),
        "transform failed: {response}"
    );
    response["ck_messages"].as_array().unwrap().clone()
}

fn is_synthetic_user(message: &Value) -> bool {
    message["role"] == json!("user") && message["meta"]["synthetic"] == json!(true)
}

fn text_of(message: &Value) -> String {
    message["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|block| block["kind"]["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Two sends of a small Broca session whose tool array has no `ctx_reduce`. What this pins,
/// send by send:
/// - send 1 is the session's first materialization (HARD): the caller's system message
///   stays first and comes back byte-for-byte unchanged (no guidance, date or tags added to
///   it); the two synthetic user rows m[0] and m[1] follow it;
/// - send 2 is a replay (the module reports it as `SOFT+`): the whole send-1 output is
///   served again byte-identical as the prefix, with only the new messages appended;
/// - without `tool_present` the tag overlay stays off, so no `§N§` tag appears on any row
///   on either send;
/// - the facade tool array read before send 1 and after send 2 is identical.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_two_sends_keep_system_and_tools_stable_and_never_tag() {
    let (handler, store, _dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    // A project doc gives m[0] (the first synthetic history row) content on the very
    // first send, as a real project with ARCHITECTURE.md or active memories would.
    std::fs::write(
        project.join("ARCHITECTURE.md"),
        "# Architecture\nBROCA-CONTRACT-DOC\n",
    )
    .unwrap();

    let tools_before = served_facade_tools(&handler, "full").await;

    let system = ck_with_role("sys", 0, "system", "Pinned mason system prompt.");
    let send_1_input = vec![system.clone(), ck("u1", 1, "First user turn.")];
    let first = call_transform_request(&handler, broca_transform_request(&send_1_input, 0)).await;
    let send_1 = served_messages(&first);
    assert_eq!(first["decision"], json!("HARD"));
    assert_eq!(first["surface_state"], json!("inactive"));
    // The served-prefix record still names the frames by their fixed ids after the system
    // message moves ahead of them; replay passes compare against these ids to detect a
    // changed m[0]/m[1].
    let recorded = store
        .load("ses")
        .unwrap()
        .meta
        .served_output_fingerprint
        .iter()
        .map(|fingerprint| fingerprint.block_id.clone())
        .collect::<Vec<_>>();
    assert_eq!(recorded, ["sys#0", "mc_m0#0", "mc_m1#0", "u1#0"]);

    let mut send_2_input = send_1_input.clone();
    send_2_input.push(ck_with_role("a1", 2, "assistant", "First answer."));
    send_2_input.push(ck("u2", 3, "Second user turn."));
    let second =
        call_transform_request(&handler, broca_transform_request(&send_2_input, 1_200)).await;
    let send_2 = served_messages(&second);
    assert_eq!(second["decision"], json!("SOFT+"));
    assert_eq!(second["surface_state"], json!("inactive"));

    let tools_after = served_facade_tools(&handler, "full").await;
    assert_eq!(
        tools_after, tools_before,
        "tool array changed between sends"
    );

    let expected_system = serde_json::to_value(&system.ck).unwrap();
    for (send, served) in [("send 1", &send_1), ("send 2", &send_2)] {
        // Layout: the caller's system message, m[0], m[1], then the rest of the caller's
        // array. Renderers that keep a system message where it sits (OpenAI chat, Responses
        // without the instructions field) must see the system prompt first.
        assert!(is_synthetic_user(&served[1]), "{send}: m[0] missing");
        assert!(is_synthetic_user(&served[2]), "{send}: m[1] missing");
        assert!(text_of(&served[1]).contains("BROCA-CONTRACT-DOC"));
        assert!(text_of(&served[1]).contains("<session-history>"));
        assert!(text_of(&served[2]).starts_with("<session-history-since>"));
        let systems = served
            .iter()
            .enumerate()
            .filter(|(_, message)| message["role"] == json!("system"))
            .collect::<Vec<_>>();
        assert_eq!(systems.len(), 1, "{send}: exactly one system message");
        assert_eq!(systems[0].0, 0, "{send}: system comes before m[0] and m[1]");
        assert_eq!(
            systems[0].1, &expected_system,
            "{send}: system message altered"
        );
        for message in served.iter() {
            assert!(
                !text_of(message).contains('§'),
                "{send}: a tag reached an owned-broca row: {message}"
            );
        }
        assert_eq!(served.len(), 2 + if send == "send 1" { 2 } else { 4 });
    }
    assert_eq!(
        send_2[..send_1.len()],
        send_1[..],
        "send 2 must replay the send-1 output byte-identical as its prefix"
    );
    assert_eq!(
        send_2[send_1.len()..]
            .iter()
            .map(text_of)
            .collect::<Vec<_>>(),
        ["First answer.", "Second user turn."]
    );

    // No tag appeared because the request did not advertise ctx_reduce, not because this
    // small fixture had nothing to tag: the same session with `tool_present` is tagged (see
    // `owned_broca_with_ctx_reduce_tags_first_sends_and_replays_served_bytes`).
    assert!(!tagging_surface_active(
        Some(SerializerProfile::OwnedBroca),
        false
    ));
    assert!(tagging_surface_active(
        Some(SerializerProfile::OwnedBroca),
        true
    ));
    // The Claude Code acknowledgement contract never applies to Broca.
    assert!(!cc_u1_active(Some(SerializerProfile::OwnedBroca), true));
}

/// A Broca request that advertises `ctx_reduce` (the caller's tool array contains it).
fn broca_reduce_request(messages: &[CkIngressMessage], input_tokens: u64) -> Value {
    let mut request = broca_transform_request(messages, input_tokens);
    request["tool_present"] = json!(true);
    request
}

/// A handler whose facade calls resolve to the transform's session `ses`, so `ctx_reduce`
/// sees the tags that session's transforms minted.
fn reduce_capable_handler() -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
    let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
    handler_with_store_and_resolver(
        Arc::new(ProducerState::default()),
        default_test_config(),
        resolver,
    )
}

fn tagged(message: &Value) -> bool {
    text_of(message).starts_with('§')
}

/// A Broca mason whose tool array includes `ctx_reduce` gets the tag overlay:
/// - send 1 (HARD) tags the first user message; the system message stays first and
///   untouched, and m[0]/m[1] are never tagged;
/// - send 2 (a defer, `SOFT+`) replays the send-1 bytes exactly and tags only the
///   messages it sends for the first time;
/// - `ctx_reduce` then accepts a served tag instead of refusing with "no valid tags";
/// - send 3 on the same input replays send 2 byte-identical.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_with_ctx_reduce_tags_first_sends_and_replays_served_bytes() {
    let (handler, _store, _dir, _project) = reduce_capable_handler();
    let system = ck_with_role("sys", 0, "system", "Pinned mason system prompt.");
    let send_1_input = vec![system.clone(), ck("u1", 1, "First user turn.")];
    let first = call_transform_request(&handler, broca_reduce_request(&send_1_input, 0)).await;
    let send_1 = served_messages(&first);
    assert_eq!(first["decision"], json!("HARD"));
    // A new session reports the switch from its stored "off" default on its first send.
    assert_eq!(first["surface_state"], json!("transition"));
    assert_eq!(send_1[0], serde_json::to_value(&system.ck).unwrap());
    assert!(is_synthetic_user(&send_1[1]) && !tagged(&send_1[1]));
    assert!(is_synthetic_user(&send_1[2]) && !tagged(&send_1[2]));
    assert!(tagged(&send_1[3]), "send 1 tags the first user message");

    let mut send_2_input = send_1_input.clone();
    send_2_input.push(ck_with_role("a1", 2, "assistant", "First answer."));
    send_2_input.push(ck("u2", 3, "Second user turn."));
    let second = call_transform_request(&handler, broca_reduce_request(&send_2_input, 1_200)).await;
    let send_2 = served_messages(&second);
    assert_eq!(second["decision"], json!("SOFT+"));
    assert_eq!(second["surface_state"], json!("active"));
    assert_eq!(
        send_2[..send_1.len()],
        send_1[..],
        "a defer pass must replay the served prefix byte-identical"
    );
    assert_eq!(send_2.len(), send_1.len() + 2);
    assert!(send_2[send_1.len()..].iter().all(tagged));

    let reduce = tool_text(call_facade(&handler, "ctx_reduce", json!({ "drop": "1" })).await);
    assert!(
        !reduce.contains("Refused"),
        "ctx_reduce must accept a tag served to a Broca session: {reduce}"
    );

    let third = call_transform_request(&handler, broca_reduce_request(&send_2_input, 1_300)).await;
    assert_eq!(third["decision"], json!("SOFT+"));
    assert_eq!(served_messages(&third), send_2);
}

/// Switching `ctx_reduce` on mid-session changes the render identity, so the module spends
/// one full rebuild (HARD) that tags the already-served history at once. Later sends replay
/// it. The switch must never trickle tags into a cached prefix on a replay pass.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_enabling_ctx_reduce_mid_session_rebuilds_once() {
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let input = vec![
        ck_with_role("sys", 0, "system", "Pinned mason system prompt."),
        ck("u1", 1, "First user turn."),
    ];
    let plain = call_transform_request(&handler, broca_transform_request(&input, 0)).await;
    assert!(!served_messages(&plain).iter().any(tagged));

    let activated = call_transform_request(&handler, broca_reduce_request(&input, 1_200)).await;
    assert_eq!(activated["decision"], json!("HARD"));
    let activated_messages = served_messages(&activated);
    assert!(tagged(activated_messages.last().unwrap()));

    let replay = call_transform_request(&handler, broca_reduce_request(&input, 1_300)).await;
    assert_eq!(replay["decision"], json!("SOFT+"));
    assert_eq!(served_messages(&replay), activated_messages);
}

/// `guidance.get` under `owned-broca` serves the reduce-capable variant exactly when the
/// caller's tool array includes `ctx_reduce`, and the variant that says it is unavailable
/// otherwise.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_guidance_variant_follows_ctx_reduce_presence() {
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    for (tool_present, variant) in [
        (true, crate::prompt_surface::GuidanceVariant::Full),
        (false, crate::prompt_surface::GuidanceVariant::NoReduce),
    ] {
        let response = call_dispatch_request(
            &handler,
            json!({
                "kind": "guidance.get",
                "session_id": "ses",
                "serializer_profile": "owned-broca",
                "tool_present": tool_present,
            }),
        )
        .await;
        assert_eq!(response["ok"], json!(true), "{response}");
        let expected = crate::prompt_surface::guidance_asset(
            crate::prompt_surface::PromptSurfacePreset::Full,
            variant,
        );
        assert!(
            response["bytes"]
                .as_str()
                .unwrap()
                .starts_with(expected.bytes),
            "tool_present={tool_present} served the wrong guidance variant"
        );
    }
}

/// Broca's names for three request fields. `cache_ttl_ms` feeds the cache-expiry
/// prediction and `overflow_error_text` the provider-overflow detection, each only when
/// the module's own field is absent. `agent_drop_ids` is accepted and ignored: `ctx_reduce`
/// calls land in the module's durable drop queue, so a caller-side copy would be a second
/// source of truth.
#[test]
fn owned_broca_wire_aliases_fill_the_module_fields() {
    let base = broca_transform_request(&[ck("u1", 1, "hi")], 0);
    let mut broca = base.clone();
    broca["cache_ttl_ms"] = json!(3_600_000);
    broca["overflow_error_text"] = json!("prompt is too long: 250000 tokens > 200000 maximum");
    broca["agent_drop_ids"] = json!(["u1"]);
    let parsed: crate::transform::TransformRequest = serde_json::from_value(broca).unwrap();
    assert_eq!(parsed.cache_ttl.as_deref(), Some("3600000"));
    assert_eq!(
        crate::scheduler::parse_cache_ttl(parsed.cache_ttl.as_deref().unwrap()),
        Ok(3_600_000)
    );
    assert_eq!(
        parsed.provider_error.as_deref(),
        Some("prompt is too long: 250000 tokens > 200000 maximum")
    );

    let mut both = base.clone();
    both["cache_ttl"] = json!("5m");
    both["cache_ttl_ms"] = json!(3_600_000);
    both["provider_error"] = json!("ours");
    both["overflow_error_text"] = json!("theirs");
    let parsed: crate::transform::TransformRequest = serde_json::from_value(both).unwrap();
    assert_eq!(parsed.cache_ttl.as_deref(), Some("5m"));
    assert_eq!(parsed.provider_error.as_deref(), Some("ours"));

    let mut without = base;
    without.as_object_mut().unwrap().remove("cache_ttl_ms");
    let parsed: crate::transform::TransformRequest = serde_json::from_value(without).unwrap();
    assert_eq!(parsed.cache_ttl, None);
    assert_eq!(parsed.provider_error, None);
}

/// `agent_drop_ids` never changes served bytes: two fresh sessions, identical except that
/// one names a drop, serve the same array.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_agent_drop_ids_are_ignored() {
    let input = vec![
        ck_with_role("sys", 0, "system", "Pinned mason system prompt."),
        ck("u1", 1, "First user turn."),
        ck_with_role("a1", 2, "assistant", "First answer."),
        ck("u2", 3, "Second user turn."),
    ];
    let mut served = Vec::new();
    for drops in [json!([]), json!(["u1", "a1"])] {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        let mut request = broca_reduce_request(&input, 0);
        request["agent_drop_ids"] = drops;
        served.push(served_messages(
            &call_transform_request(&handler, request).await,
        ));
    }
    assert_eq!(served[0], served[1]);
}

/// Stamp the envelope ordinal into `meta.ordinal`, as Broca does so it can map output
/// messages back to its input by `meta` rather than by position.
fn broca_message(mut message: CkIngressMessage) -> CkIngressMessage {
    message.ck.meta.ordinal = Some(message.ordinal);
    message
}

fn assistant_reasoning_then_text(mid: &str, ordinal: u64) -> CkIngressMessage {
    CkIngressMessage {
        mid: mid.to_string(),
        ordinal,
        ck: CkWireMessage::from_parts(
            "assistant",
            vec![
                CkWireBlock::bare(CkKind::Reasoning {
                    text: format!("thinking about {mid}"),
                    signature: Some(format!("signature-{mid}")),
                }),
                CkWireBlock::bare(CkKind::Text {
                    text: format!("answer from {mid}"),
                }),
            ],
            None,
            ProviderExtras::new(),
            HarnessMeta {
                harness_id: Some(mid.to_string()),
                ..Default::default()
            },
        ),
    }
}

/// Check the identity contract Broca relies on to map a transformed array back to its
/// input: every retained message keeps its own `harness_id` and `ordinal`, no two output
/// messages share a `harness_id`, and module-created rows carry neither field.
fn assert_meta_identity(send: &str, input: &[CkIngressMessage], served: &[Value]) {
    let mut seen = std::collections::HashSet::new();
    for message in served {
        let meta = &message["meta"];
        if meta["synthetic"] == json!(true) {
            assert!(
                meta.get("harness_id").is_none() && meta.get("ordinal").is_none(),
                "{send}: a module-created row carries caller identity: {message}"
            );
            continue;
        }
        let harness_id = meta["harness_id"]
            .as_str()
            .unwrap_or_else(|| panic!("{send}: a retained message lost harness_id: {message}"));
        assert!(
            seen.insert(harness_id.to_string()),
            "{send}: harness_id {harness_id} appears on two output messages"
        );
        let source = input
            .iter()
            .find(|candidate| candidate.ck.meta.harness_id.as_deref() == Some(harness_id))
            .unwrap_or_else(|| panic!("{send}: harness_id {harness_id} is not an input id"));
        assert_eq!(
            meta["ordinal"],
            json!(source.ordinal),
            "{send}: {harness_id} changed ordinal"
        );
        assert_eq!(
            message["role"],
            json!(source.ck.role),
            "{send}: {harness_id} role"
        );
    }
}

/// Pin the per-message identity Broca uses to restore its cache markers after the module
/// changes the array's length, across the operations that rewrite or remove messages under
/// `owned-broca`: a coverage fold that removes covered history and adds the m[0]/m[1] head
/// rows, the system message moving ahead of those rows, tag prefixes, caveman compression of
/// an old user message, and a queued `ctx_reduce` drop that replaces a tool result and
/// skeletonizes its call. Reasoning clearing never runs under `owned-broca`, so the
/// reasoning block passes through.
///
/// The same invariants hold for the compaction-off path, which only adds head rows (see
/// `owned_broca_compaction_off_keeps_system_first`).
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_retained_messages_keep_their_harness_id_and_ordinal() {
    let (handler, _store, _dir, _project) = reduce_capable_handler();
    let imported = call_dispatch_request(
        &handler,
        state_import_request(
            "broca-identity",
            0,
            1,
            vec![imported_compartment(1, 1, 4, "m4#0", "early setup work")],
        ),
    )
    .await;
    assert_eq!(imported["imported"], json!(1), "{imported}");

    let long_output = format!("tool output {}", "line of build log ".repeat(200));
    let mut input = vec![
        ck_with_role("sys", 0, "system", "Pinned mason system prompt."),
        ck("m1", 1, "Covered request one."),
        ck_with_role("m2", 2, "assistant", "Covered answer two."),
        ck("m3", 3, "Covered request three."),
        ck_with_role("m4", 4, "assistant", "Covered answer four."),
        ck(
            "m5",
            5,
            "Please make sure that you really do run the whole test suite before you commit.",
        ),
        assistant_tool_call("call-6", 6),
        tool_result("result-6", 7, &long_output),
        assistant_reasoning_then_text("r8", 8),
        ck("m9", 9, "Next request."),
    ]
    .into_iter()
    .map(broca_message)
    .collect::<Vec<_>>();

    let mut request = broca_reduce_request(&input, 1_000);
    request["caveman_enabled"] = json!(true);
    request["caveman_min_chars"] = json!(20);
    let first = call_transform_request(&handler, request).await;
    let send_1 = served_messages(&first);
    assert_eq!(first["decision"], json!("HARD"), "{first}");
    assert_meta_identity("send 1", &input, &send_1);
    let served_ids = send_1
        .iter()
        .filter_map(|message| message["meta"]["harness_id"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        served_ids,
        ["sys", "m5", "call-6", "result-6", "r8", "m9"],
        "the fold removes m1..m4 and keeps the leading system message"
    );
    assert_eq!(send_1[0]["role"], json!("system"));
    assert!(is_synthetic_user(&send_1[1]) && is_synthetic_user(&send_1[2]));

    let result_text = send_1
        .iter()
        .find(|message| message["meta"]["harness_id"] == json!("result-6"))
        .unwrap()["content"][0]["kind"]["output"]
        .to_string();
    let tag = result_text
        .split('§')
        .nth(1)
        .expect("the tool result is tagged")
        .to_string();
    let reduce = tool_text(call_facade(&handler, "ctx_reduce", json!({ "drop": tag })).await);
    assert!(!reduce.contains("Refused"), "{reduce}");

    input.push(broca_message(ck("m10", 10, "Keep going.")));
    let mut request = broca_reduce_request(&input, 190_000);
    request["caveman_enabled"] = json!(true);
    request["caveman_min_chars"] = json!(20);
    let second = call_transform_request(&handler, request).await;
    let send_2 = served_messages(&second);
    assert_ne!(second["decision"], json!("SOFT+"), "{second}");
    assert_meta_identity("send 2", &input, &send_2);
    let dropped_result = send_2
        .iter()
        .find(|message| message["meta"]["harness_id"] == json!("result-6"))
        .unwrap();
    assert!(
        !dropped_result.to_string().contains("line of build log"),
        "the queued drop replaced the tool output: {dropped_result}"
    );
    let by_id = |id: &str| {
        send_2
            .iter()
            .find(|message| message["meta"]["harness_id"] == json!(id))
            .unwrap()
            .clone()
    };
    assert_eq!(
        by_id("call-6")["content"][0]["kind"]["input"],
        json!({ "command": "printf output" }),
        "a small dropped call keeps its real arguments; only its output is replaced"
    );
    let caveman_text = text_of(&by_id("m5"));
    assert!(
        !caveman_text.contains("Please") && caveman_text.contains("test suite"),
        "caveman compression rewrote the old user message: {caveman_text}"
    );
}

/// With compaction off the module serves the additive-only m[0]/m[1] frame. Under
/// `owned-broca` the caller's leading system message still comes first there, and every
/// caller message keeps its identity.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_compaction_off_keeps_system_first() {
    let mut config = default_test_config();
    config.compaction_enabled = false;
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), config);
    let input = vec![
        ck_with_role("sys", 0, "system", "Pinned mason system prompt."),
        ck("u1", 1, "First user turn."),
    ]
    .into_iter()
    .map(broca_message)
    .collect::<Vec<_>>();
    let response = call_transform_request(&handler, broca_transform_request(&input, 0)).await;
    let served = served_messages(&response);
    assert_eq!(served[0], serde_json::to_value(&input[0].ck).unwrap());
    assert!(is_synthetic_user(&served[1]) && is_synthetic_user(&served[2]));
    assert_eq!(served[3], serde_json::to_value(&input[1].ck).unwrap());
    assert_eq!(served.len(), 4);
    assert_meta_identity("compaction off", &input, &served);
}
