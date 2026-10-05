use super::*;

fn joined_reference(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => canonical_number(value),
        Value::String(value) => serde_json::to_string(value).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(joined_reference)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        joined_reference(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[test]
fn streamed_canonical_value_matches_joined_reference_and_numeric_contract() {
    for value in [
        json!({"z":[true,false,null,{"深":"é🙂\"\\\n\0"}],"a":[{},[],""]}),
        json!([-0.0, 0.0, 1.0, 1.25, 1e-30, 1e30, u64::MAX, i64::MIN]),
        json!({"body":"text\n".repeat(100_000),"nested":{"z":[1,2],"a":null}}),
    ] {
        assert_eq!(canonical_value(&value), joined_reference(&value));
    }
    assert_eq!(canonical_value(&json!([-0.0, 1.0, 1.25])), "[-0,1,1.25]");
}

#[test]
fn borrowed_state_wire_decode_matches_owned_values_and_errors() {
    for value in [
        json!({"v":1,"session_id":"s","import_id":"i","batch_seq":0,"batch_count":1,
            "compartments":[{"seq":1,"start_message":0,"end_message":2,"end_message_id":"m",
                "title":"é","p1":"body","unknown":{"discarded":[1,2]}}],
            "unknown":{"large":"ignored"}}),
        json!({"v":true}),
        json!(null),
    ] {
        let old = serde_json::from_value::<StateImportWire>(value.clone())
            .map(|wire| format!("{wire:?}"))
            .map_err(|error| error.to_string());
        let new = decode_state_import_wire(&value)
            .map(|wire| format!("{wire:?}"))
            .map_err(|error| error.to_string());
        assert_eq!(new, old);
    }
    for value in [
        json!({"session_id":"s","shadow_generation":1,"expected_shadow_seq":0,
            "drop_seeds":[{"block_id":"m#0","drop_mode":"drop","payload":"é"}],"unknown":[1,2]}),
        json!({"shadow_generation":1.0,"expected_shadow_seq":0}),
        json!(null),
    ] {
        let old = serde_json::from_value::<ModuleStateSyncWire>(value.clone())
            .map(|wire| format!("{wire:?}"))
            .map_err(|error| error.to_string());
        let new = decode_state_sync_wire(&value)
            .map(|wire| format!("{wire:?}"))
            .map_err(|error| error.to_string());
        assert_eq!(new, old);
    }
}
