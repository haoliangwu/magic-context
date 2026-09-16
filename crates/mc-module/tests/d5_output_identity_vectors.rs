use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

const FIXTURE_NAME: &str = "output-identity-vectors-v1.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    contract_version: String,
    source_evidence: SourceEvidence,
    returned_view_grammar: ReturnedViewGrammar,
    observed_geometry: ObservedGeometry,
    manifest_carry_members: Vec<ManifestCarryMember>,
    returned_arrays: Vec<ReturnedArray>,
    unit_locators: Vec<UnitLocator>,
    descent_mappings: Vec<DescentMapping>,
    vectors: Vec<Vector>,
    unsettled: Vec<serde_json::Value>,
    mc_output_boundary_only: McOutputBoundaryOnly,
    generation: Generation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceEvidence {
    private_specimen_store: PrivateSpecimenStore,
    sanitized_public_source: SanitizedPublicSource,
    producer_meta_passthrough: SourceCitation,
    descent_rebase_stamp: SourceCitation,
    harness_meta: SourceCitation,
    synthetic_mid_literals: SourceCitation,
    implementation_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivateSpecimenStore {
    source: String,
    sha256: String,
    facts: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SanitizedPublicSource {
    path: String,
    messages: Vec<u64>,
    fact: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceCitation {
    path: String,
    lines: String,
    fact: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReturnedViewGrammar {
    view_name: String,
    separate_from_preimage_types: bool,
    coordinate_source: String,
    native_message_ce1_assignment: String,
    source_segment_ce1_assignment: String,
    preimage_change: String,
    evaluation_order: Vec<String>,
    evaluation_scope: String,
    proof_mismatch_transport: String,
    outside_scope: String,
    synthetic_serving_mids: String,
    synthesized_messages: String,
    gateway_identity_fields: Vec<String>,
    gateway_view_limit: String,
    provider_rendering: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ObservedGeometry {
    successor_m0_payload_bytes: usize,
    successor_m1_payload_bytes: usize,
    content_rule: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestCarryMember {
    native_mid: String,
    source_ordinal: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReturnedArray {
    id: String,
    base: Option<String>,
    insert_before_position: Option<u64>,
    shape: String,
    messages: Vec<ReturnedMessage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReturnedMessage {
    position: u64,
    message_class: String,
    role: String,
    blocks: Vec<ReturnedBlock>,
    meta: ReturnedMeta,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReturnedBlock {
    index: u64,
    kind: String,
    bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReturnedMeta {
    harness_id: Option<String>,
    ordinal: Option<u64>,
    synthetic: bool,
    summary: Option<bool>,
    errored: Option<bool>,
    finish: Option<String>,
    created_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitLocator {
    id: String,
    unit: String,
    mid: String,
    index: u64,
    expected_bytes_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DescentMapping {
    id: String,
    array: String,
    returned_position: u64,
    mid: String,
    ordinal_continuation_base: u64,
    manifest_predecessor_ordinal: u64,
    fresh_origin_ordinal: u64,
    rebased_ordinal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    array: String,
    mutations: Vec<Mutation>,
    unit_locator: Option<String>,
    descent_mapping: Option<String>,
    outstanding_carry: bool,
    expected: Verdict,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Mutation {
    RemoveHarnessId {
        position: u64,
    },
    DuplicateMid {
        from_position: u64,
        to_position: u64,
    },
    SetStamp {
        position: u64,
        harness_id: Option<String>,
        ordinal: Option<u64>,
        synthetic: bool,
    },
    AlterBytes {
        position: u64,
        index: u64,
        bytes_base64: String,
    },
    SwapMids {
        first_position: u64,
        second_position: u64,
    },
    SetNonIdentityMeta {
        position: u64,
        summary: Option<bool>,
        errored: Option<bool>,
        finish: Option<String>,
        created_at_ms: Option<i64>,
        completed_at_ms: Option<i64>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Verdict {
    outcome: String,
    positions: Vec<PositionIdentity>,
    gateway_verdict: Option<GatewayVerdict>,
    defect: Option<Defect>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct PositionIdentity {
    position: u64,
    mid: String,
    ordinal: Option<u64>,
    synthetic: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct GatewayVerdict {
    evaluated: bool,
    classification: String,
    http_status: Option<u16>,
    error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Defect {
    field: String,
    reason: String,
    returned_position: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct McOutputBoundaryOnly {
    verified_by: String,
    native_passthrough: NativePassthrough,
    synthesized_fields_must_be_absent: Vec<String>,
    synthesized_negative_vectors: Vec<BoundaryVector>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativePassthrough {
    array: String,
    returned_position: u64,
    mid: String,
    ingress_non_identity_meta_json: String,
    returned_non_identity_meta_json: String,
    expected: BoundaryVerdict,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BoundaryVector {
    id: String,
    name: String,
    array: String,
    mutation: Mutation,
    expected: BoundaryVerdict,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct BoundaryVerdict {
    outcome: String,
    meta_bytes_equal: Option<bool>,
    defect: Option<Defect>,
}

#[derive(Serialize)]
struct NonIdentityMeta<'a> {
    summary: Option<bool>,
    errored: Option<bool>,
    finish: &'a Option<String>,
    created_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    fixture_kind: String,
    index_source: String,
    generation_script: String,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join(FIXTURE_NAME)).expect("read output identity fixture");
    let fixture = serde_json::from_slice(&bytes).expect("parse output identity fixture schema");
    (fixture, bytes)
}

fn decode_base64(encoded: &str) -> Vec<u8> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let input = encoded.as_bytes();
    let (chunks, remainder) = input.as_chunks::<4>();
    assert!(remainder.is_empty(), "base64 length must divide by four");
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for chunk in chunks {
        let a = sextet(chunk[0]).expect("base64 character");
        let b = sextet(chunk[1]).expect("base64 character");
        let c = if chunk[2] == b'=' {
            0
        } else {
            sextet(chunk[2]).expect("base64 character")
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            sextet(chunk[3]).expect("base64 character")
        };
        output.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    output
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn vector<'a>(fixture: &'a Fixture, id: &str) -> &'a Vector {
    fixture
        .vectors
        .iter()
        .find(|vector| vector.id == id)
        .unwrap_or_else(|| panic!("missing output identity vector {id}"))
}

fn returned_array<'a>(fixture: &'a Fixture, id: &str) -> &'a ReturnedArray {
    fixture
        .returned_arrays
        .iter()
        .find(|array| array.id == id)
        .unwrap_or_else(|| panic!("missing returned array {id}"))
}

fn assemble_array(fixture: &Fixture, id: &str) -> Vec<ReturnedMessage> {
    let array = returned_array(fixture, id);
    let mut messages = if let Some(base) = &array.base {
        assert_ne!(base, id, "returned array cannot extend itself");
        assemble_array(fixture, base)
    } else {
        Vec::new()
    };
    match (&array.base, array.insert_before_position) {
        (None, None) => messages.extend(array.messages.clone()),
        (Some(_), Some(insert_at)) => {
            let added = u64::try_from(array.messages.len()).expect("message count fits u64");
            for message in &mut messages {
                if message.position >= insert_at {
                    message.position += added;
                }
            }
            messages.extend(array.messages.clone());
        }
        _ => panic!("returned array {} has an incomplete extension", array.id),
    }
    messages.sort_by_key(|message| message.position);
    assert_eq!(
        messages
            .iter()
            .map(|message| message.position)
            .collect::<Vec<_>>(),
        (0..messages.len() as u64).collect::<Vec<_>>(),
        "returned array {} positions",
        array.id
    );
    messages
}

fn message_at(messages: &mut [ReturnedMessage], position: u64) -> &mut ReturnedMessage {
    messages
        .iter_mut()
        .find(|message| message.position == position)
        .unwrap_or_else(|| panic!("returned position {position} is absent"))
}

fn apply_mutations(messages: &mut [ReturnedMessage], mutations: &[Mutation]) {
    for mutation in mutations {
        match mutation {
            Mutation::RemoveHarnessId { position } => {
                message_at(messages, *position).meta.harness_id = None;
            }
            Mutation::DuplicateMid {
                from_position,
                to_position,
            } => {
                let mid = message_at(messages, *from_position).meta.harness_id.clone();
                message_at(messages, *to_position).meta.harness_id = mid;
            }
            Mutation::SetStamp {
                position,
                harness_id,
                ordinal,
                synthetic,
            } => {
                let meta = &mut message_at(messages, *position).meta;
                meta.harness_id.clone_from(harness_id);
                meta.ordinal = *ordinal;
                meta.synthetic = *synthetic;
            }
            Mutation::AlterBytes {
                position,
                index,
                bytes_base64,
            } => {
                let message = message_at(messages, *position);
                let block = message
                    .blocks
                    .iter_mut()
                    .find(|block| block.index == *index)
                    .unwrap_or_else(|| panic!("returned block {position}#{index} is absent"));
                block.bytes_base64.clone_from(bytes_base64);
            }
            Mutation::SwapMids {
                first_position,
                second_position,
            } => {
                let first = message_at(messages, *first_position)
                    .meta
                    .harness_id
                    .clone();
                let second = message_at(messages, *second_position)
                    .meta
                    .harness_id
                    .clone();
                message_at(messages, *first_position).meta.harness_id = second;
                message_at(messages, *second_position).meta.harness_id = first;
            }
            Mutation::SetNonIdentityMeta {
                position,
                summary,
                errored,
                finish,
                created_at_ms,
                completed_at_ms,
            } => {
                let meta = &mut message_at(messages, *position).meta;
                meta.summary = *summary;
                meta.errored = *errored;
                meta.finish.clone_from(finish);
                meta.created_at_ms = *created_at_ms;
                meta.completed_at_ms = *completed_at_ms;
            }
        }
    }
}

fn field_refusal(position: u64, field: String, reason: String) -> Verdict {
    Verdict {
        outcome: "REFUSED".to_string(),
        positions: Vec::new(),
        gateway_verdict: Some(GatewayVerdict {
            evaluated: true,
            classification: "proof_mismatch".to_string(),
            http_status: Some(503),
            error_code: Some("d5_carry_proof_mismatch".to_string()),
        }),
        defect: Some(Defect {
            field,
            reason,
            returned_position: position,
        }),
    }
}

fn evaluate(fixture: &Fixture, vector: &Vector) -> Verdict {
    if !vector.outstanding_carry {
        return Verdict {
            outcome: "not_evaluated".to_string(),
            positions: Vec::new(),
            gateway_verdict: None,
            defect: None,
        };
    }
    let mut messages = assemble_array(fixture, &vector.array);
    apply_mutations(&mut messages, &vector.mutations);
    let manifest = fixture
        .manifest_carry_members
        .iter()
        .map(|member| (member.native_mid.as_str(), member.source_ordinal))
        .collect::<BTreeMap<_, _>>();
    let mut seen = BTreeMap::<String, u64>::new();
    let mut positions = Vec::with_capacity(messages.len());

    for message in &messages {
        let position = message.position;
        let Some(mid) = message.meta.harness_id.as_deref() else {
            return field_refusal(
                position,
                format!("returned_messages[{position}].meta.harness_id"),
                "required serving MID stamp is missing".to_string(),
            );
        };
        if let Some(first_position) = seen.insert(mid.to_string(), position) {
            return field_refusal(
                position,
                format!("returned_messages[{position}].meta.harness_id"),
                format!("serving MID duplicates returned position {first_position}"),
            );
        }
        if let Some(source_ordinal) = manifest.get(mid) {
            if message.meta.synthetic {
                return field_refusal(
                    position,
                    format!("returned_messages[{position}].meta.synthetic"),
                    "manifest-named carry member cannot claim synthetic".to_string(),
                );
            }
            if message.meta.ordinal != Some(*source_ordinal) {
                let actual = message
                    .meta
                    .ordinal
                    .map_or_else(|| "none".to_string(), |ordinal| ordinal.to_string());
                return field_refusal(
                    position,
                    format!("returned_messages[{position}].meta.ordinal"),
                    format!("manifest source ordinal is {source_ordinal}, got {actual}"),
                );
            }
        } else if message.meta.synthetic {
            if message.meta.ordinal.is_some() {
                return field_refusal(
                    position,
                    format!("returned_messages[{position}].meta.ordinal"),
                    "synthetic returned message must not carry an ordinal".to_string(),
                );
            }
        } else if message.meta.ordinal.is_none() {
            return field_refusal(
                position,
                format!("returned_messages[{position}].meta.ordinal"),
                "native returned message requires a source ordinal".to_string(),
            );
        }
        positions.push(PositionIdentity {
            position,
            mid: mid.to_string(),
            ordinal: message.meta.ordinal,
            synthetic: message.meta.synthetic,
        });
    }

    if let Some(locator_id) = &vector.unit_locator {
        let locator = fixture
            .unit_locators
            .iter()
            .find(|locator| locator.id == *locator_id)
            .unwrap_or_else(|| panic!("missing unit locator {locator_id}"));
        let located = messages.iter().find_map(|message| {
            (message.meta.harness_id.as_deref() == Some(locator.mid.as_str())).then(|| {
                message
                    .blocks
                    .iter()
                    .find(|block| block.index == locator.index)
            })
        });
        let actual = located
            .flatten()
            .map(|block| decode_base64(&block.bytes_base64));
        let expected = decode_base64(&locator.expected_bytes_base64);
        if actual.as_deref() != Some(expected.as_slice()) {
            let position = messages
                .iter()
                .find(|message| message.meta.harness_id.as_deref() == Some(locator.mid.as_str()))
                .map_or(0, |message| message.position);
            return field_refusal(
                position,
                format!("unit_locators[{}].bytes", locator.id),
                "returned bytes at (mid, index) do not match the committed unit".to_string(),
            );
        }
    }

    Verdict {
        outcome: "accepted".to_string(),
        positions,
        gateway_verdict: Some(GatewayVerdict {
            evaluated: true,
            classification: "accepted".to_string(),
            http_status: None,
            error_code: None,
        }),
        defect: None,
    }
}

fn non_identity_meta_json(meta: &ReturnedMeta) -> String {
    serde_json::to_string(&NonIdentityMeta {
        summary: meta.summary,
        errored: meta.errored,
        finish: &meta.finish,
        created_at_ms: meta.created_at_ms,
        completed_at_ms: meta.completed_at_ms,
    })
    .expect("serialize non-identity HarnessMeta")
}

fn evaluate_boundary_vector(fixture: &Fixture, vector: &BoundaryVector) -> BoundaryVerdict {
    let mut messages = assemble_array(fixture, &vector.array);
    apply_mutations(&mut messages, std::slice::from_ref(&vector.mutation));
    for message in messages.iter().filter(|message| message.meta.synthetic) {
        let fields = [
            ("summary", message.meta.summary.is_some()),
            ("errored", message.meta.errored.is_some()),
            ("finish", message.meta.finish.is_some()),
            ("created_at_ms", message.meta.created_at_ms.is_some()),
            ("completed_at_ms", message.meta.completed_at_ms.is_some()),
        ];
        if let Some((field, _)) = fields.into_iter().find(|(_, present)| *present) {
            return BoundaryVerdict {
                outcome: "malformed".to_string(),
                meta_bytes_equal: None,
                defect: Some(Defect {
                    field: format!("returned_messages[{}].meta.{field}", message.position),
                    reason: format!("synthesized returned message must not carry {field}"),
                    returned_position: message.position,
                }),
            };
        }
    }
    BoundaryVerdict {
        outcome: "accepted".to_string(),
        meta_bytes_equal: None,
        defect: None,
    }
}

fn assert_vector(fixture: &Fixture, id: &str) {
    let vector = vector(fixture, id);
    assert_eq!(
        evaluate(fixture, vector),
        vector.expected,
        "{}: {}",
        vector.id,
        vector.name
    );
}

#[test]
fn d5_output_identity_fixture_parses_and_reserializes_byte_identically() {
    let (fixture, bytes) = load_fixture();
    let raw: Box<RawValue> = serde_json::from_slice(&bytes).expect("parse raw fixture JSON");
    let mut reserialized = serde_json::to_vec(&raw).expect("re-serialize raw fixture JSON");
    reserialized.push(b'\n');
    assert_eq!(reserialized, bytes);
    assert_eq!(fixture.schema, "mc.d5.output-identity-vectors.v1");
    assert_eq!(fixture.contract_version, "1.3.25");
    assert_eq!(
        fixture.source_evidence.private_specimen_store.sha256,
        "f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0"
    );
    assert!(fixture
        .source_evidence
        .private_specimen_store
        .source
        .contains("MC_D5_SPECIMEN_DB"));
    assert!(fixture
        .source_evidence
        .private_specimen_store
        .facts
        .contains("ordinal_continuation_base is 1939"));
    assert_eq!(
        fixture.source_evidence.sanitized_public_source.path,
        "crates/mc-module/tests/fixtures/d5-specimen/source-segment-v1.json"
    );
    assert_eq!(
        fixture.source_evidence.sanitized_public_source.messages,
        [1823, 1824]
    );
    assert!(fixture
        .source_evidence
        .sanitized_public_source
        .fact
        .contains("copied from the sanitized specimen"));
    assert_eq!(
        fixture.source_evidence.producer_meta_passthrough.path,
        "crates/mc-module/src/transform.rs"
    );
    assert_eq!(
        fixture.source_evidence.producer_meta_passthrough.lines,
        "13624-13625"
    );
    assert!(fixture
        .source_evidence
        .producer_meta_passthrough
        .fact
        .contains("retaining ingress meta"));
    assert_eq!(
        fixture.source_evidence.descent_rebase_stamp.lines,
        "2546-2593"
    );
    assert!(fixture
        .source_evidence
        .descent_rebase_stamp
        .fact
        .contains("line 2592 stamps meta.ordinal"));
    assert_eq!(
        fixture.source_evidence.harness_meta.path,
        "crates/mc-store/src/lib.rs"
    );
    assert_eq!(fixture.source_evidence.harness_meta.lines, "57-79");
    assert!(fixture
        .source_evidence
        .harness_meta
        .fact
        .contains("HarnessMeta"));
    assert!(fixture
        .source_evidence
        .synthetic_mid_literals
        .fact
        .contains("M0_ID is mc_m0"));
    assert!(fixture
        .source_evidence
        .implementation_status
        .contains("intentionally absent"));
}

#[test]
fn d5_output_identity_returned_view_does_not_change_ce1_preimages() {
    let (fixture, _) = load_fixture();
    let grammar = &fixture.returned_view_grammar;
    assert_eq!(grammar.view_name, "ReturnedMessageViewV1");
    assert!(grammar.separate_from_preimage_types);
    assert!(grammar.coordinate_source.contains("meta.harness_id"));
    assert!(grammar.coordinate_source.contains("meta.ordinal"));
    assert!(grammar.native_message_ce1_assignment.contains("mc.d5.F.v1"));
    assert!(grammar
        .source_segment_ce1_assignment
        .contains("mc.d5.manifest.v1"));
    assert!(grammar.preimage_change.starts_with("none"));
    assert!(grammar.evaluation_scope.contains("clause-21a"));
    assert!(grammar.proof_mismatch_transport.contains("HTTP 503"));
    assert!(grammar
        .proof_mismatch_transport
        .contains("d5_carry_proof_mismatch"));
    assert!(grammar.outside_scope.contains("no gateway verdict"));
    assert!(grammar.synthetic_serving_mids.contains("<call_id>:call"));
    assert_eq!(
        grammar.synthesized_messages,
        "Only m0, m1, and the synthetic todo pair are returned synthesized messages."
    );
    assert_eq!(
        grammar.gateway_identity_fields,
        ["harness_id", "ordinal", "synthetic"]
    );
    assert!(grammar.gateway_view_limit.contains("and nothing else"));
    assert_eq!(
        grammar.provider_rendering,
        "Provider rendering omits all HarnessMeta metadata."
    );
    assert_eq!(
        grammar.evaluation_order,
        [
            "returned position ascending",
            "harness_id required",
            "serving MID unique",
            "manifest carry binding",
            "synthetic/native ordinal shape",
            "unit locator bytes",
        ]
    );
}

#[test]
fn d5_output_identity_specimen_meta_and_sanitized_carry_are_exact() {
    let (fixture, _) = load_fixture();
    let main = assemble_array(&fixture, "specimen-main");
    assert_eq!(
        main.iter()
            .map(|message| message.message_class.as_str())
            .collect::<Vec<_>>(),
        ["m0", "m1", "carry", "carry", "native_suffix"]
    );
    assert_eq!(main[0].meta.harness_id.as_deref(), Some("mc_m0"));
    assert_eq!(main[1].meta.harness_id.as_deref(), Some("mc_m1"));
    for prefix in &main[..2] {
        assert!(prefix.meta.synthetic);
        assert_eq!(prefix.meta.ordinal, None);
    }
    assert_eq!(decode_base64(&main[0].blocks[0].bytes_base64).len(), 65_585);
    assert_eq!(decode_base64(&main[1].blocks[0].bytes_base64).len(), 90);
    assert_eq!(fixture.observed_geometry.successor_m0_payload_bytes, 65_585);
    assert_eq!(fixture.observed_geometry.successor_m1_payload_bytes, 90);
    assert!(fixture
        .observed_geometry
        .content_rule
        .contains("equal-length stand-in"));

    let source: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("source-segment-v1.json")).expect("read source segment"),
    )
    .expect("parse source segment");
    for returned in &main[2..4] {
        let ordinal = returned.meta.ordinal.expect("carry ordinal");
        let source_message = source["messages"]
            .as_array()
            .expect("source messages")
            .iter()
            .find(|message| message["ordinal"].as_u64() == Some(ordinal))
            .expect("source carry member");
        assert_eq!(
            source_message["mid"].as_str(),
            returned.meta.harness_id.as_deref()
        );
        assert_eq!(
            source_message["role"].as_str(),
            Some(returned.role.as_str())
        );
        for block in &returned.blocks {
            let source_block = source_message["blocks"]
                .as_array()
                .expect("source blocks")
                .iter()
                .find(|source_block| source_block["index"].as_u64() == Some(block.index))
                .expect("source block index");
            assert_eq!(source_block["kind"].as_str(), Some(block.kind.as_str()));
            assert_eq!(
                source_block["bytes"].as_str(),
                Some(block.bytes_base64.as_str())
            );
        }
    }
    assert_eq!(main[4].meta.harness_id.as_deref(), Some("ccm-1940"));
    assert_eq!(main[4].meta.ordinal, Some(1940));
    assert!(!main[4].meta.synthetic);
    assert!(returned_array(&fixture, "specimen-main")
        .shape
        .contains("native suffix 1940"));
}

#[test]
fn d5_output_identity_vectors_match_owner_authored_verdicts() {
    let (fixture, _) = load_fixture();
    for vector in &fixture.vectors {
        assert_eq!(
            evaluate(&fixture, vector),
            vector.expected,
            "{}: {}",
            vector.id,
            vector.name
        );
    }
}

#[test]
fn d5_output_identity_well_formed_array_is_position_exact() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V01_well_formed");
    let expected = &vector(&fixture, "V01_well_formed").expected;
    assert_eq!(expected.outcome, "accepted");
    assert_eq!(
        expected
            .positions
            .iter()
            .map(|entry| entry.mid.as_str())
            .collect::<Vec<_>>(),
        ["mc_m0", "mc_m1", "ccm-1823", "ccm-1824", "ccm-1940"]
    );
}

#[test]
fn d5_output_identity_every_returned_position_is_accounted_once() {
    let (fixture, _) = load_fixture();
    for vector in fixture
        .vectors
        .iter()
        .filter(|vector| vector.expected.outcome == "accepted")
    {
        let returned_len = assemble_array(&fixture, &vector.array).len();
        let positions = vector
            .expected
            .positions
            .iter()
            .map(|entry| entry.position)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            vector.expected.positions.len(),
            returned_len,
            "{}",
            vector.id
        );
        assert_eq!(positions.len(), returned_len, "{}", vector.id);
        assert_eq!(
            positions,
            (0..returned_len as u64).collect::<BTreeSet<_>>(),
            "{}",
            vector.id
        );
    }
    for vector in fixture
        .vectors
        .iter()
        .filter(|vector| vector.expected.outcome == "REFUSED")
    {
        assert!(vector.expected.positions.is_empty(), "{}", vector.id);
        let gateway = vector
            .expected
            .gateway_verdict
            .as_ref()
            .expect("refused carry path has a gateway verdict");
        assert!(gateway.evaluated, "{}", vector.id);
        assert_eq!(gateway.classification, "proof_mismatch", "{}", vector.id);
        assert_eq!(gateway.http_status, Some(503), "{}", vector.id);
        assert_eq!(
            gateway.error_code.as_deref(),
            Some("d5_carry_proof_mismatch"),
            "{}",
            vector.id
        );
        assert!(vector.expected.defect.is_some(), "{}", vector.id);
    }
}

#[test]
fn d5_output_identity_unstamped_message_refuses() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V02_unstamped");
}

#[test]
fn d5_output_identity_duplicate_mid_refuses() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V03_duplicate_mid");
}

#[test]
fn d5_output_identity_manifest_carry_cannot_claim_synthetic() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V04_carry_claims_synthetic");
}

#[test]
fn d5_output_identity_manifest_carry_requires_source_ordinal() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V05_carry_wrong_ordinal");
}

#[test]
fn d5_output_identity_synthetic_locator_binds_actual_bytes() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V06_synthetic_todo_locator");
    assert_vector(&fixture, "V07_synthetic_todo_locator_altered");
    let locator = &fixture.unit_locators[0];
    assert_eq!(locator.unit, "unit:synthetic-todo-result");
    assert_eq!(locator.index, 0);
    let messages = assemble_array(&fixture, "specimen-with-synthetic-todo");
    let call_id = "mc_synthetic_todo_c4a22134ee90be17";
    let call_mid = format!("{call_id}:call");
    let result_mid = format!("{call_id}:result");
    assert_eq!(
        messages[4].meta.harness_id.as_deref(),
        Some(call_mid.as_str())
    );
    assert_eq!(
        messages[5].meta.harness_id.as_deref(),
        Some(result_mid.as_str())
    );
    for message in &messages[4..=5] {
        assert!(message.meta.synthetic);
        assert_eq!(message.meta.ordinal, None);
        assert_eq!(message.meta.summary, None);
        assert_eq!(message.meta.errored, None);
        assert_eq!(message.meta.finish, None);
        assert_eq!(message.meta.created_at_ms, None);
        assert_eq!(message.meta.completed_at_ms, None);
    }
}

#[test]
fn d5_output_identity_no_outstanding_carry_has_no_gateway_verdict() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V12_no_outstanding_carry_no_view");
    let vector = vector(&fixture, "V12_no_outstanding_carry_no_view");
    assert!(!vector.outstanding_carry);
    assert_eq!(vector.expected.outcome, "not_evaluated");
    assert!(vector.expected.gateway_verdict.is_none());
    assert!(vector.expected.defect.is_none());
}

#[test]
fn d5_output_identity_mc_output_boundary_preserves_native_meta_and_rejects_synthetic_meta() {
    let (fixture, _) = load_fixture();
    let boundary = &fixture.mc_output_boundary_only;
    assert_eq!(
        boundary.verified_by,
        "mc stamping output wire (mc-module transform); not gateway round-trip"
    );
    assert_eq!(
        boundary.synthesized_fields_must_be_absent,
        [
            "summary",
            "errored",
            "finish",
            "created_at_ms",
            "completed_at_ms",
        ]
    );
    let native = &boundary.native_passthrough;
    let messages = assemble_array(&fixture, &native.array);
    let message = &messages[native.returned_position as usize];
    assert_eq!(
        message.meta.harness_id.as_deref(),
        Some(native.mid.as_str())
    );
    let output_bytes = non_identity_meta_json(&message.meta);
    assert_eq!(output_bytes, native.ingress_non_identity_meta_json);
    assert_eq!(output_bytes, native.returned_non_identity_meta_json);
    assert_eq!(native.expected.outcome, "accepted");
    assert_eq!(native.expected.meta_bytes_equal, Some(true));
    assert!(native.expected.defect.is_none());

    assert_eq!(boundary.synthesized_negative_vectors.len(), 5);
    for vector in &boundary.synthesized_negative_vectors {
        assert_eq!(
            evaluate_boundary_vector(&fixture, vector),
            vector.expected,
            "{}: {}",
            vector.id,
            vector.name
        );
    }
}

#[test]
fn d5_output_identity_descent_uses_real_continuation_base() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V08_descent_rebased_ordinal");
    let mapping_id = vector(&fixture, "V08_descent_rebased_ordinal")
        .descent_mapping
        .as_deref()
        .expect("descent mapping id");
    let mapping = fixture
        .descent_mappings
        .iter()
        .find(|mapping| mapping.id == mapping_id)
        .expect("descent mapping");
    assert_eq!(mapping.ordinal_continuation_base, 1939);
    assert_eq!(mapping.manifest_predecessor_ordinal, 0);
    assert_eq!(mapping.fresh_origin_ordinal, 0);
    assert_eq!(
        mapping.rebased_ordinal,
        mapping.ordinal_continuation_base
            + 1
            + (mapping.manifest_predecessor_ordinal - mapping.fresh_origin_ordinal)
    );
    let messages = assemble_array(&fixture, &mapping.array);
    let returned = &messages[mapping.returned_position as usize];
    assert_eq!(
        returned.meta.harness_id.as_deref(),
        Some(mapping.mid.as_str())
    );
    assert_eq!(returned.meta.ordinal, Some(mapping.rebased_ordinal));
}

#[test]
fn d5_output_identity_synthetic_with_ordinal_refuses() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V09_synthetic_with_ordinal");
}

#[test]
fn d5_output_identity_refusal_precedence_is_fixture_data() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V10_precedence_unstamped_before_later_duplicate");
    let defect = vector(&fixture, "V10_precedence_unstamped_before_later_duplicate")
        .expected
        .defect
        .as_ref()
        .expect("expected defect");
    assert_eq!(defect.returned_position, 2);
}

#[test]
fn d5_output_identity_swapped_position_mids_refuse() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V11_swapped_carry_mids");
}

#[test]
fn d5_output_identity_v1325_rulings_leave_no_fixture_silences() {
    let (fixture, bytes) = load_fixture();
    assert!(fixture.unsettled.is_empty());
    assert!(!String::from_utf8(bytes)
        .expect("fixture UTF-8")
        .contains("lineage_boundary"));
    assert_eq!(fixture.generation.fixture_kind, "owner-authored");
    assert_eq!(
        fixture.generation.index_source,
        "owner-authored D5 returned-message output identity vectors"
    );
    assert_eq!(
        fixture.generation.generation_script,
        "packages/plugin/scripts/gen-d5-specimen-fixture.py"
    );
}

#[test]
fn d5_output_identity_fixture_is_indexed() {
    let (_, fixture_bytes) = load_fixture();
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    let entry = index["files"]
        .as_array()
        .expect("index files")
        .iter()
        .find(|entry| entry["path"] == FIXTURE_NAME)
        .expect("output identity fixture index entry");
    assert_eq!(
        entry["byte_size"].as_u64(),
        Some(fixture_bytes.len() as u64)
    );
    assert_eq!(
        entry["sha256"].as_str(),
        Some(sha256_hex(&fixture_bytes).as_str())
    );
    assert_eq!(entry["derived"].as_bool(), Some(false));
    assert_eq!(
        entry["source"].as_str(),
        Some("owner-authored D5 returned-message output identity vectors")
    );
}
