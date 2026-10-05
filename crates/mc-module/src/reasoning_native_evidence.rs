/// Record native replay proof only during legacy migration. The compare-and-swap
/// binds the proof to the CK snapshot that built this response, not a later load
/// from another transform or state-sync transaction.
#[allow(clippy::too_many_arguments)]
fn record_reasoning_native_evidence(
    store: &mc_store::McStore,
    response: &mut transform::TransformResponse,
    request: &TransformRequest,
    units: &[mc_core::FrozenUnit],
    tags: &BTreeMap<String, u64>,
    mutation_exempt_mid: Option<&str>,
    lineage_anchor_mid: Option<&str>,
    transition_consumed: bool,
) -> Result<(), mc_store::McStoreError> {
    let legacy_mids = units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_clear_legacy:"))
        .collect::<HashSet<_>>();
    if legacy_mids.is_empty() {
        return Ok(());
    }
    let Some(native) = response.native_messages.as_ref() else {
        return Ok(());
    };
    let mut loaded = store.load(&request.session_id)?;
    if loaded.row_version != Some(response.row_version) || loaded.meta.reasoning_clear_initialized {
        return Ok(());
    }
    let candidate_units = units
        .iter()
        .map(|unit| {
            let mut unit = unit.clone();
            if let Some(mid) = unit.key.strip_prefix("strip:reasoning_clear_legacy:") {
                unit.key = format!("strip:reasoning_clear:{mid}");
                unit.kind = "strip_reasoning_clear".to_string();
            }
            unit
        })
        .collect::<Vec<_>>();
    let candidate = encode_full_native_messages(
        response,
        request,
        &candidate_units,
        tags,
        mutation_exempt_mid,
        lineage_anchor_mid,
        transition_consumed,
    );
    let collect = |messages: Vec<Value>| {
        messages
            .into_iter()
            .filter_map(|message| {
                let mid = message["info"]["id"].as_str()?;
                legacy_mids
                    .contains(mid)
                    .then(|| (mid.to_string(), message.clone()))
            })
            .collect()
    };
    loaded.meta.reasoning_replay_evidence = Some(mc_store::ReasoningReplayEvidence {
        row_version: response.row_version + 1,
        generation: (
            loaded.meta.revert_epoch,
            loaded.meta.shadow_generation,
            loaded.meta.shadow_seq,
        ),
        source_hash: transform::reasoning_native_source_hash(request),
        ck_fingerprints: loaded.meta.served_output_fingerprint.clone(),
        native: collect(native.iter().map(|value| value.as_ref().clone()).collect()),
        unit_native: collect(candidate),
    });
    // Only meta changes here. The full load above is for the hydrated served fingerprints,
    // which the small row does not carry; the write itself is meta-only.
    response.row_version =
        store.commit_meta(&request.session_id, loaded.row_version, &loaded.meta)?;
    response.committed = true;
    Ok(())
}
