//! Isolated production-helper costs on the profiling harness's reconstructed fixtures.
//! These are operation costs, not claims that a conditional operation runs every pass.

use super::*;

#[test]
fn empty_pending_drop_helpers_skip_frozen_and_projection_indexes() {
    let core = CoreState::default();
    let projection = ck_wire::project_messages(&[]).unwrap();
    crate::per_pass_profile::begin_pass();
    assert!(!pending_agent_drops_applied_this_pass(&[], &core, &core));
    assert!(first_applied_pending_command_ids(&[], &core, &core).is_empty());
    assert!(consumed_pending_drop_ids(&[], &core, &core, &projection, None).is_empty());
    let costs = crate::per_pass_profile::end_pass();
    assert!(
        !costs.contains_key("rt12_red_targets"),
        "an empty queue must not build frozen indexes"
    );
}

fn measure(session: &str, finding: &str, shape: &str, mut operation: impl FnMut()) {
    let mut cpu = Vec::new();
    for sample in 0..23 {
        crate::per_pass_profile::begin_pass();
        let span = crate::per_pass_profile::start("isolated_operation");
        operation();
        crate::per_pass_profile::finish(span);
        let costs = crate::per_pass_profile::end_pass();
        if sample >= 3 {
            cpu.push(costs["isolated_operation"].thread_cpu_ms);
        }
    }
    cpu.sort_by(f64::total_cmp);
    println!(
        "COST_MICRO {}",
        serde_json::json!({"session":session,
        "finding":finding,"shape":shape,"n":cpu.len(),
        "thread_cpu_p50_ms":(cpu[9]+cpu[10])/2.0})
    );
}

pub(crate) fn measure_fixture(
    req: &TransformRequest,
    core: &CoreState,
    meta: &ModuleMeta,
    tags: &[McTagRow],
) {
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let live: Vec<_> = projection
        .blocks
        .iter()
        .filter(|block| is_tail(block.ordinal, meta.coverage_ordinal))
        .collect();
    let tag_tokens: HashMap<_, _> = tags
        .iter()
        .filter_map(|row| {
            usize::try_from(row.token_count)
                .ok()
                .map(|count| (row.block_id.as_str(), count))
        })
        .collect();
    measure(&req.session_id, "RT-5", "taggable_kind_all_blocks", || {
        for block in &projection.blocks {
            let _ = std::hint::black_box(taggable_kind(std::hint::black_box(block)));
        }
    });
    measure(&req.session_id, "RT-5", "active_tags_for_nudge", || {
        std::hint::black_box(active_tags_for_nudge(core, meta, &projection, tags, None));
    });
    measure(&req.session_id, "RT-12", "one_frozen_red_set", || {
        std::hint::black_box(frozen_red_targets(std::hint::black_box(core)));
    });
    measure(
        &req.session_id,
        "RT-12",
        "empty_pending_drop_helpers",
        || {
            std::hint::black_box(pending_agent_drops_applied_this_pass(&[], core, core));
            std::hint::black_box(first_applied_pending_command_ids(&[], core, core));
            std::hint::black_box(consumed_pending_drop_ids(
                &[],
                core,
                core,
                &projection,
                meta.coverage_ordinal,
            ));
        },
    );
    measure(&req.session_id, "RT-13", "todo_normalize_scan", || {
        let _ = std::hint::black_box(normalize_synthetic_todo_ingress(std::hint::black_box(req)));
    });
    measure(
        &req.session_id,
        "RT-16",
        "publication_floor_on_hard",
        || {
            std::hint::black_box(protected_tail_floor_ordinal(
                &live,
                200_000.0,
                70.0,
                mc_tokenizer::estimate_tokens,
            ));
        },
    );
    measure(
        &req.session_id,
        "RT-4",
        "tail_selection_input_construction",
        || {
            std::hint::black_box(tail_sel_items(&live, meta.coverage_ordinal, &tag_tokens));
        },
    );
    let selection = tail_sel_items(&live, meta.coverage_ordinal, &tag_tokens);
    measure(&req.session_id, "RT-4", "todo_capture_clone", || {
        std::hint::black_box(selection.clone());
    });
    measure(
        &req.session_id,
        "RT-20",
        "projected_tool_input_copies",
        || {
            for block in &projection.blocks {
                let _ = std::hint::black_box(block.tool_input.as_deref().cloned());
            }
        },
    );
    measure(
        &req.session_id,
        "RT-15",
        "strip_lookup_all_ingress_messages",
        || {
            for message in &req.messages {
                let _ =
                    std::hint::black_box(message_strip_unit(core, "reasoning_age", &message.mid));
            }
        },
    );
}
