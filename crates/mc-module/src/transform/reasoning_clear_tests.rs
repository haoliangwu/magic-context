fn reasoning_clear_fixture() -> TransformRequest {
    fn message(mid: &str, ordinal: u64, role: &str, signed: bool) -> CkIngressMessage {
        let mut content = Vec::new();
        if signed {
            content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: format!("thinking-{mid}"),
                signature: Some(format!("signature-{mid}")),
            }));
        }
        content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
            text: format!("content-{mid}"),
        }));
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                content,
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }
    let mut multipart = message("multipart-user", 4, "user", false);
    for index in 0..12 {
        multipart
            .ck
            .content
            .push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: format!("Additional user text part {index}"),
            }));
    }
    let mut request = active_opencode_req(
        "reasoning-clear-decisions",
        "cfg0",
        vec![
            message("user", 1, "user", false),
            message("old", 2, "assistant", true),
            multipart,
        ],
    );
    request.provider_id = Some("anthropic".to_string());
    request.serve_native = true;
    request.clear_reasoning_age = 10;
    with_usage(request, 10_000, 100_000)
}

fn reasoning_clear_target(response: &TransformResponse) -> Vec<u8> {
    response
        .messages()
        .iter()
        .find(|message| message.meta.harness_id.as_deref() == Some("old"))
        .unwrap()
        .canonical_bytes()
        .to_vec()
}

fn reasoning_clear_native(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Vec<Value> {
    crate::encode_full_native_messages(
        &result.response,
        request,
        &result.reasoning_clear_units,
        &result.tag_numbers,
        result.mutation_exempt_mid.as_deref(),
        result.lineage_anchor_mid.as_deref(),
        result.transition_consumed,
    )
}

fn reasoning_clear_native_target(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Value {
    reasoning_clear_native(result, request)
        .into_iter()
        .find(|message| message["info"]["id"] == "old")
        .unwrap()
}

#[test]
fn reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = reasoning_clear_fixture();
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let original = reasoning_clear_target(&hard.response);
    let original_native = reasoning_clear_native_target(&hard, &request);
    assert!(String::from_utf8_lossy(&original).contains("thinking-old"));
    assert!(hard.reasoning_watermark >= hard.tag_numbers["old"]);
    drop(db);
    let db = store(dir.path());
    let unchanged = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(unchanged.response.action, "SOFT+");
    assert_eq!(reasoning_clear_target(&unchanged.response), original);
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let deferred = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    assert_eq!(deferred.reasoning_watermark, hard.reasoning_watermark);
    assert_eq!(
        reasoning_clear_target(&deferred.response),
        original,
        "DEFER must not first-clear reasoning merely because its exemption moved"
    );
    assert_eq!(
        reasoning_clear_native_target(&deferred, &request),
        original_native
    );
    assert!(deferred.response.first_divergence.is_none());
    request.render_config = "cfg2".to_string();
    let applied = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(applied.response.action, "HARD");
    let cleared = reasoning_clear_target(&applied.response);
    let cleared_native = reasoning_clear_native_target(&applied, &request);
    assert!(!String::from_utf8_lossy(&cleared).contains("thinking-old"));
    assert_ne!(original_native, cleared_native);
    for _ in 0..2 {
        let replay = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert_eq!(reasoning_clear_target(&replay.response), cleared);
        assert_eq!(
            reasoning_clear_native_target(&replay, &request),
            cleared_native
        );
        assert!(replay.response.first_divergence.is_none());
    }
}

#[test]
fn reasoning_clear_legacy_missing_fingerprint_holds_until_bust() {
    let mut request = reasoning_clear_fixture();
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let core = CoreState::default();
    let meta = ModuleMeta {
        reasoning_cleared_through_tag: 5,
        ..Default::default()
    };
    let tags = BTreeMap::from([("old".to_string(), 2), ("new".to_string(), 16)]);
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    assert!(new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        false,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection
        }
    )
    .is_empty());
    let units = new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        true,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection,
        },
    );
    assert_eq!(reasoning_clear_mids(&units), HashSet::from(["old"]));
}

/// OpenCode tool-loop shape on OpenAI Responses: each assistant step carries a reasoning
/// part whose encrypted payload lives in provider metadata, then a visible answer.
fn opencode_openai_removal_request(steps: usize, provider: &str, model: &str) -> TransformRequest {
    let mut native = vec![json!({"info":{"id":"user-0","role":"user"},"parts":[
        {"id":"user-0-t","type":"text","text":"do the work"}]})];
    for step in 0..steps {
        let id = format!("a{step}");
        native.push(json!({"info":{"id":id,"role":"assistant"},"parts":[
            {"id":format!("{id}-r"),"type":"reasoning","text":format!("thinking-{id}"),
             "metadata":{"openai":{"itemId":format!("rs_{id}"),"reasoningEncryptedContent":format!("ENC_{id}")}}},
            {"id":format!("{id}-t"),"type":"text","text":format!("answer-{id}")}]}));
    }
    native.push(json!({"info":{"id":"user-last","role":"user"},"parts":[
        {"id":"user-last-t","type":"text","text":"continue"}]}));
    let messages = crate::codec::decode_opencode(&native).messages;
    let mut request = active_opencode_req("reasoning-removal-openai", "cfg0", messages);
    request.native_messages = Some(native);
    request.provider_id = Some(provider.to_string());
    request.model_key = Some(format!("{provider}/{model}"));
    request.serve_native = true;
    request.clear_reasoning_age = 3;
    with_usage(request, 10_000, 100_000)
}

fn native_reasoning_parts(native: &[Value], mid: &str) -> usize {
    native
        .iter()
        .find(|message| message["info"]["id"] == mid)
        .and_then(|message| message["parts"].as_array())
        .map(|parts| parts.iter().filter(|part| part["type"] == "reasoning").count())
        .unwrap_or(0)
}

#[test]
fn opencode_non_anthropic_removes_old_reasoning_on_bust_and_replays_on_defer() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    // A short session first: nothing is old enough yet.
    let short = opencode_openai_removal_request(2, "openai", "gpt-6.1-sol");
    transform_with_projection(&db, &short, &ctx).unwrap();

    // The loop grows on defer passes; a defer pass never originates a removal.
    let mut request = opencode_openai_removal_request(6, "openai", "gpt-6.1-sol");
    let deferred = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    let deferred_native = reasoning_clear_native(&deferred, &request);
    // Defer passes never mint a removal unit.
    assert!(!db
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key.starts_with("strip:reasoning_age:")));
    let _ = deferred_native;

    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let hard_native = reasoning_clear_native(&hard, &request);
    // Tags: user-0=1, a0=2, a1=3, user-last=4, a2..a5=5..8. Cutoff 8-3=5.
    let minted: HashSet<String> = db
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_age:").map(str::to_string))
        .collect();
    assert_eq!(
        minted,
        HashSet::from(["a0".to_string(), "a1".to_string(), "a2".to_string()])
    );
    let removed: Vec<_> = (0..6)
        .map(|step| format!("a{step}"))
        .filter(|mid| native_reasoning_parts(&hard_native, mid) == 0)
        .collect();
    assert!(!removed.is_empty(), "the bust must remove old reasoning");
    assert!(!removed.contains(&"a5".to_string()), "the newest assistant keeps its reasoning");
    assert_eq!(native_reasoning_parts(&hard_native, "a5"), 1);
    let wire = serde_json::to_string(&hard_native).unwrap();
    for mid in &removed {
        assert!(!wire.contains(&format!("ENC_{mid}")), "{mid} encrypted payload left the wire");
        assert!(wire.contains(&format!("answer-{mid}")), "{mid} answer must survive");
    }
    // No canonical-Anthropic empty-shell unit is used on this route.
    assert!(reasoning_clear_mids(&hard.reasoning_clear_units).is_empty());

    for _ in 0..2 {
        let replay = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert_eq!(
            serde_json::to_string(&reasoning_clear_native(&replay, &request)).unwrap(),
            wire
        );
        assert!(replay.response.first_divergence.is_none());
    }
}

#[test]
fn opencode_canonical_anthropic_does_not_use_the_removal_lane() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = opencode_openai_removal_request(6, "anthropic", "claude-sonnet-5");
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let loaded = db.load(&request.session_id).unwrap();
    assert!(!loaded
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key.starts_with("strip:reasoning_age:")));
}

/// Anthropic's "What counts as an edit" table
/// (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking): "Remove a
/// `thinking` block from the middle of the history and keep later ones" is invalid for every
/// later thinking block, so on a prefix-bound model the walk stops at the first message it may
/// not remove. Unresolved and OpenRouter routes still select nothing.
#[test]
fn opencode_removal_stops_at_the_first_ineligible_message_on_prefix_bound_models() {
    let mut request =
        opencode_openai_removal_request(6, "google-vertex-anthropic", "claude-opus-5-5@20260930");
    // a2 keeps only its reasoning, so removing it would leave no content.
    request.messages[3].ck.content.retain(is_reasoning_block);
    let tags: BTreeMap<String, u64> = request
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| (message.mid.clone(), index as u64 + 1))
        .collect();
    let none = HashSet::new();
    assert_eq!(
        opencode_reasoning_removal_mids(&request, &tags, Some(6), &none),
        HashSet::from(["a0", "a1"])
    );
    // Steps already removed are passed over; the walk still stops at a2.
    let a0_removed = HashSet::from(["strip:reasoning_age:a0"]);
    assert_eq!(
        opencode_reasoning_removal_mids(&request, &tags, Some(6), &a0_removed),
        HashSet::from(["a1"])
    );
    request.provider_id = None;
    request.model_key = Some("openai/gpt-6.1-sol".to_string());
    assert!(opencode_reasoning_removal_mids(&request, &tags, Some(6), &none).is_empty());
    request.provider_id = Some("openrouter".to_string());
    request.model_key = Some("openrouter/anthropic/claude-haiku-4.5".to_string());
    assert!(opencode_reasoning_removal_mids(&request, &tags, Some(6), &none).is_empty());
    request.provider_id = Some("openai".to_string());
    request.model_key = Some("openai/gpt-6.1-sol".to_string());
    // An ineligible message (a2) does not stop the walk on unbound models.
    let unbound = opencode_reasoning_removal_mids(&request, &tags, Some(6), &none);
    assert_eq!(unbound, HashSet::from(["a0", "a1", "a3", "a4"]));
    assert!(is_prefix_bound_thinking_model(Some("amazon-bedrock/us.anthropic.claude-fable-5-1-v1:0")));
    assert!(is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5-5")));
    assert!(!is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5")));
    assert!(!is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5-50")));
}

/// The same scenarios as the TypeScript and Pi lanes, from one shared golden file.
#[test]
fn opencode_prefix_bound_removal_matches_the_shared_golden() {
    let golden: Value =
        serde_json::from_str(include_str!("../../testdata/prefix-bound-reasoning-trim.json"))
            .unwrap();
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect()
    };
    for scenario in golden["cases"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let steps = scenario["steps"].as_u64().unwrap() as usize;
        let untagged = strings(&scenario["untagged"]);
        let already = strings(&scenario["already_removed"]);
        let request =
            opencode_openai_removal_request(steps, "google-vertex-anthropic", "claude-opus-5-5");
        let mut tags = BTreeMap::from([("user-0".to_string(), 1)]);
        for step in 0..steps {
            let mid = format!("a{step}");
            if !untagged.contains(&mid) {
                tags.insert(mid, step as u64 + 2);
            }
        }
        let max_tag = tags.values().copied().max().unwrap();
        let cutoff = max_tag - scenario["clear_reasoning_age"].as_u64().unwrap();
        let keys: Vec<String> = already
            .iter()
            .map(|mid| format!("strip:reasoning_age:{mid}"))
            .collect();
        let existing: HashSet<&str> = keys.iter().map(String::as_str).collect();
        let selected = opencode_reasoning_removal_mids(&request, &tags, Some(cutoff), &existing);
        let mut after: Vec<String> = already
            .iter()
            .cloned()
            .chain(selected.iter().map(|mid| mid.to_string()))
            .collect();
        after.sort();
        let mut expected = strings(&scenario["removed_after"]);
        expected.sort();
        assert_eq!(after, expected, "{name}");
    }
}

fn minted_reasoning_age(db: &McStore, session_id: &str) -> BTreeSet<String> {
    db.load(session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_age:").map(str::to_string))
        .collect()
}

/// A prefix-bound OpenCode session that bootstraps with two steps, gets a compartment boundary,
/// grows to eight steps on a defer pass, and then takes a force-band pass whose only fresh work
/// is the age removal. `overlays` turns the tag and hint overlays on; the bust then also lands
/// the overlays withheld from assistants demoted on the defer pass.
struct PrefixBoundTrimRun {
    db: McStore,
    dir: tempfile::TempDir,
    grown: TransformRequest,
    served: Vec<Value>,
    trim: TransformWithProjection,
    trimmed: Vec<Value>,
}

fn prefix_bound_trim_run(overlays: bool) -> PrefixBoundTrimRun {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    let request = |steps: usize| {
        let mut request =
            opencode_openai_removal_request(steps, "google-vertex-anthropic", "claude-opus-5-5");
        if !overlays {
            // No visible tag surface and no hints. Caveman tagging still mints tag rows (its
            // texts here are too short to compress), which the age cutoff needs.
            request.tool_present = false;
            request.auto_search_enabled = false;
            request.caveman_enabled = true;
        }
        request
    };
    // A short session first: its bootstrap bust has nothing old enough to remove.
    let short = request(2);
    let bootstrap = transform_with_projection(&db, &short, &ctx).unwrap();
    assert!(!bootstrap.response.reasoning_trim_only);
    // A published compartment gives the session the boundary a later SOFT pass splices onto.
    let first_ordinal = short.messages[0].ordinal as i64;
    db.replace_compartments(
        &short.session_id,
        &[comp(0, first_ordinal, first_ordinal, "user-0", "S0")],
    )
    .unwrap();
    let fold = transform_with_projection(&db, &short, &ctx).unwrap();
    assert_eq!(fold.response.action, "HARD");
    assert!(!fold.response.boundary_id.is_empty());
    assert!(!fold.response.reasoning_trim_only);

    // The loop grows on defer passes, which never remove anything.
    let grown = request(8);
    let deferred = transform_with_projection(&db, &grown, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    let served = reasoning_clear_native(&deferred, &grown);
    assert!(minted_reasoning_age(&db, &grown.session_id).is_empty());

    // A force-band pass: busting, with nothing to do but the reasoning removal.
    let pressured = with_usage(grown.clone(), 96_000, 100_000);
    let trim = transform_with_projection(&db, &pressured, &ctx).unwrap();
    assert_eq!(trim.response.action, "SOFT");
    assert_eq!(trim.response.materialize_reason.as_deref(), Some("selection"));
    let trimmed = reasoning_clear_native(&trim, &pressured);
    drop(ctx);
    PrefixBoundTrimRun {
        db,
        dir,
        grown,
        served,
        trim,
        trimmed,
    }
}

/// "Remove `thinking` blocks from the start of the history, from the end, or all of them" is
/// valid in Anthropic's table, so a prefix-bound bust whose only edit is that removal reports
/// `reasoning_trim_only` and the host keeps every newer block. Any other edit (here a render
/// config change that rebuilds the prefix) reports false, so the host strips them all.
#[test]
fn prefix_bound_trim_only_bust_reports_reasoning_trim_only_and_keeps_newer_blocks() {
    let PrefixBoundTrimRun {
        db,
        dir,
        grown,
        served,
        trim,
        trimmed,
    } = prefix_bound_trim_run(false);
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    assert!(trim.response.reasoning_trim_only);
    let minted = minted_reasoning_age(&db, &grown.session_id);
    assert!(!minted.is_empty());
    // The removed set is a contiguous oldest prefix, and every newer assistant is unchanged.
    let mut kept_started = false;
    for step in 0..8 {
        let mid = format!("a{step}");
        let removed = native_reasoning_parts(&trimmed, &mid) == 0;
        assert_eq!(removed, minted.contains(&mid), "{mid}");
        if removed {
            assert!(!kept_started, "{mid} removed after a kept block");
        } else {
            kept_started = true;
            let find = |native: &[Value]| {
                native
                    .iter()
                    .find(|message| message["info"]["id"] == mid.as_str())
                    .cloned()
                    .unwrap()
            };
            assert_eq!(find(&trimmed), find(&served), "{mid} changed");
        }
    }
    assert!(kept_started);

    let wire = serde_json::to_string(&trimmed).unwrap();
    for _ in 0..2 {
        let replay = transform_with_projection(&db, &grown, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert!(!replay.response.reasoning_trim_only);
        assert_eq!(
            serde_json::to_string(&reasoning_clear_native(&replay, &grown)).unwrap(),
            wire
        );
    }

    let mut rebuilt = grown.clone();
    rebuilt.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &rebuilt, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    assert!(!hard.response.reasoning_trim_only);
}

/// "Add a text block to an earlier user turn" and "Edit ... any earlier `user`, `assistant`, or
/// `system` message" are invalid in Anthropic's table. With the tag overlays on, the same bust
/// also lands the overlays withheld from assistants demoted on the defer pass, so it reports
/// false and the host strips every block.
#[test]
fn prefix_bound_bust_that_also_lands_withheld_overlays_is_not_trim_only() {
    let run = prefix_bound_trim_run(true);
    assert!(!minted_reasoning_age(&run.db, &run.grown.session_id).is_empty());
    assert!(!run.trim.response.reasoning_trim_only);
    // The edit is real: a step too young for the age removal gains its tag prefix, and the
    // native encoder drops its reasoning along with it.
    let minted = minted_reasoning_age(&run.db, &run.grown.session_id);
    assert!(!minted.contains("a6"));
    let find = |native: &[Value]| {
        native
            .iter()
            .find(|message| message["info"]["id"] == "a6")
            .cloned()
            .unwrap()
    };
    assert_ne!(find(&run.trimmed), find(&run.served));
}

#[test]
fn reasoning_cutoff_is_not_captured_for_prefix_bound_models() {
    let mut request = reasoning_clear_fixture();
    let tags = BTreeMap::from([("old".to_string(), 2), ("multipart-user".to_string(), 30)]);
    let profile = Some(SerializerProfile::OpencodeAiSdk);
    request.model_key = Some("anthropic/claude-sonnet-5".to_string());
    assert!(reasoning_clear_cutoff_with_tags(&request, profile, true, &tags).is_some());
    request.model_key = Some("anthropic/claude-opus-5-5".to_string());
    assert_eq!(reasoning_clear_cutoff_with_tags(&request, profile, true, &tags), None);
    let claude_code = Some(SerializerProfile::ClaudeCodeAnthropic);
    assert_eq!(reasoning_clear_cutoff_with_tags(&request, claude_code, true, &tags), None);
}

#[test]
fn opencode_removal_skips_messages_carrying_openrouter_reasoning_details_under_any_provider_id() {
    let mut request = opencode_openai_removal_request(6, "my-gateway", "anthropic/claude-haiku-4.5");
    let natives = request.native_messages.as_mut().unwrap();
    natives[2]["parts"][1]["metadata"] =
        json!({"openrouter":{"reasoning_details":[{"type":"reasoning.text","format":"anthropic-claude-v1"}]}});
    let tags: BTreeMap<String, u64> = request
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| (message.mid.clone(), index as u64 + 1))
        .collect();
    let selected = opencode_reasoning_removal_mids(&request, &tags, Some(6), &HashSet::new());
    assert!(!selected.contains("a1"), "{selected:?}");
    assert!(selected.contains("a0"));
}

// The TypeScript hosts serve an aged assistant text block with inline <think>
// markup as the frozen caveman payload with the markup removed: they replay
// caveman compression first and then strip inline thinking from that result.
// Rust renders the caveman payload first too, but the surface strip must read
// the rendered payload rather than the request's pristine text, or the block
// is served uncompressed and the two runtimes send different bytes.
#[test]
#[ignore = "fixing this changes served bytes on deploy; enable with the next cache-format epoch change"]
fn aged_inline_thinking_strip_keeps_the_frozen_caveman_payload() {
    let source = "The implementation has been completed <think>stale private thought</think> and the verification results are available for the reviewer. I just really wanted to basically explain the context clearly. ".repeat(3);
    let mut answer = item("m1", 1, &source);
    answer.ck.role = "assistant".to_string();
    let mut latest = item("m3", 3, "latest answer");
    latest.ck.role = "assistant".to_string();
    let mut request = req(
        "caveman-inline-thinking",
        "cfg",
        vec![answer, item("m2", 2, "next request"), latest],
    );
    request.caveman_enabled = true;
    let projection = project_messages(&request.messages).unwrap();
    let payload = crate::caveman::compress(&source, crate::caveman::CavemanLevel::Ultra);
    assert!(payload.contains("<think>stale private thought</think>"));
    assert_ne!(
        inline_thinking_replacement(&payload),
        inline_thinking_replacement(&source),
        "the fixture must make caveman change the stripped bytes"
    );
    let core = CoreState {
        frozen_units: vec![caveman_unit("m1#0", 3, &payload)],
        ..CoreState::default()
    };
    let tag_numbers = BTreeMap::from([
        ("m1".to_string(), 1),
        ("m2".to_string(), 2),
        ("m3".to_string(), 3),
    ]);
    // Watermark 1 ages m1 for the inline-thinking strip.
    let output = build_output_with_tags(
        &core,
        &ModuleMeta::default(),
        &projection,
        &request,
        None,
        false,
        None,
        &tag_numbers,
        1,
        false,
        None,
        true,
    )
    .unwrap();
    let served = output
        .messages
        .into_iter()
        .map(ServedMessage::into_message)
        .find(|message| message.meta.harness_id.as_deref() == Some("m1"))
        .expect("m1 is served");
    assert_eq!(
        first_block_text(&served.content[0]),
        Some(inline_thinking_replacement(&payload).as_str())
    );
}
