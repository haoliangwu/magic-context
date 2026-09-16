use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_NAME: &str = "scope-open-vectors-v1.json";
const INDEX_SOURCE: &str = "owner-authored D5 scope.open contract vectors";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    contract_version: String,
    encoding_rule: EncodingRule,
    exact_encodings: Vec<ExactEncoding>,
    refusal_vectors: Vec<RefusalVector>,
    sequences: Vec<Sequence>,
    generation: Generation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    lineage_request: String,
    lineage_response: String,
    nested_unions: String,
    unknown_keys: String,
    implementation_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactEncoding {
    id: String,
    message: String,
    bytes_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefusalVector {
    id: String,
    name: String,
    request_bytes_base64: String,
    expected_bytes_base64: String,
    field: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sequence {
    id: String,
    name: String,
    recreation_observation: Option<RecreationObservation>,
    initial_state: DurableState,
    concurrent_calls: Option<Vec<ConcurrentCall>>,
    all_invoked_before_first_completion: Option<bool>,
    steps: Vec<SequenceStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecreationObservation {
    prior_incarnation: u64,
    pre_recreation_scope_row: ScopeRow,
    current_incarnation: u64,
    resolve_generation_transition: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConcurrentCall {
    call_id: String,
    request_bytes_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceStep {
    operation: SequenceOperation,
    expected: SequenceExpected,
    response_bytes_base64: Option<String>,
    state_after: DurableState,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SequenceOperation {
    #[serde(rename = "scope.open")]
    ScopeOpen {
        call_id: Option<String>,
        request_bytes_base64: String,
    },
    #[serde(rename = "gateway.reconcile")]
    GatewayReconcile {
        attempt_id: String,
        opened_incarnation: u64,
    },
    #[serde(rename = "prepare")]
    Prepare {
        attempt_id: String,
        incarnation: u64,
        admission_ticket: AdmissionTicket,
    },
    #[serde(rename = "resolve")]
    Resolve {
        attempt_id: String,
        incarnation: u64,
        admission_ticket: AdmissionTicket,
        original_ticket_used: bool,
        new_ticket_sampled: bool,
    },
    #[serde(rename = "attempt.ticket")]
    AttemptTicket {
        arguments: TicketArguments,
        request_encoding: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SequenceExpected {
    #[serde(rename = "OPENED")]
    Opened {
        incarnation: u64,
        lineage_id: String,
        resolve_generation: u64,
        created: bool,
    },
    #[serde(rename = "FAIL_CLOSED")]
    FailClosed {
        record_preserved: bool,
        obligation_intact: bool,
        incarnation_adopted: bool,
    },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
    #[serde(rename = "NOT_ENCODABLE")]
    NotEncodable { field: String, reason: String },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DurableState {
    owner_incarnation_counter: u64,
    owner_current_lineage: Option<String>,
    scope_rows: Vec<ScopeRow>,
    gateway_attempts: Vec<GatewayAttempt>,
    mc_attempt_rows: Vec<Value>,
    ticket_rows: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ScopeRow {
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    lineage_id: String,
    resolve_generation: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GatewayAttempt {
    attempt_id: String,
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    #[serde(rename = "F")]
    fingerprint: MaterialFingerprint,
    allocation_ref: String,
    ingress: IngressEvidence,
    admission_ticket: AdmissionTicket,
    ticket_cas_bound: bool,
    ticket_sample_count: u64,
    obligation: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MaterialFingerprint {
    digest: String,
    normalization_version: u64,
    excluded_additions: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IngressEvidence {
    boot_id: String,
    watermark: u64,
    sequence_seen: u64,
    ownership_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AdmissionTicket {
    resolve_generation: u64,
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
    incarnation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketArguments {
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    fixture_kind: String,
    index_source: String,
    generation_script: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "op", deny_unknown_fields)]
enum ScopeRequest {
    #[serde(rename = "scope.open")]
    ScopeOpen {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
enum ScopeResponse {
    #[serde(rename = "scope.open")]
    ScopeOpen { result: ScopeResult },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum ScopeResult {
    #[serde(rename = "OPENED")]
    Opened {
        incarnation: u64,
        lineage_id: String,
        resolve_generation: u64,
        created: bool,
    },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Refusal {
    reason: RefusalReason,
    #[serde(default)]
    receipt_id: Option<String>,
    details: RefusalDetails,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalReason {
    InvalidArguments,
    StaleIncarnation,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RefusalDetails {
    Field { field: String, reason: String },
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join(FIXTURE_NAME)).expect("read scope.open vectors");
    let fixture = serde_json::from_slice(&bytes).expect("parse scope.open fixture schema");
    (fixture, bytes)
}

fn sequence<'a>(fixture: &'a Fixture, id: &str) -> &'a Sequence {
    fixture
        .sequences
        .iter()
        .find(|sequence| sequence.id == id)
        .unwrap_or_else(|| panic!("missing sequence {id}"))
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
    assert_eq!(
        input.len() % 4,
        0,
        "base64 length must be divisible by four"
    );
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for chunk in input.as_chunks::<4>().0 {
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

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(c & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn wire_bytes(encoded: &str) -> Vec<u8> {
    let bytes = decode_base64(encoded);
    assert_eq!(encode_base64(&bytes), encoded, "base64 must be canonical");
    bytes
}

fn parse_exact<T>(encoded: &str, label: &str) -> T
where
    T: DeserializeOwned + Serialize,
{
    let bytes = wire_bytes(encoded);
    let value = serde_json::from_slice::<T>(&bytes)
        .unwrap_or_else(|error| panic!("{label} does not parse: {error}"));
    assert_eq!(
        serde_json::to_vec(&value).expect("serialize parsed wire value"),
        bytes,
        "{label} must re-serialize byte-identically"
    );
    value
}

fn refusal(field: &str, reason: &str, refusal_reason: RefusalReason) -> Refusal {
    Refusal {
        reason: refusal_reason,
        receipt_id: None,
        details: RefusalDetails::Field {
            field: field.to_owned(),
            reason: reason.to_owned(),
        },
    }
}

fn invalid_request_refusal(bytes: &[u8]) -> Refusal {
    let value: Value = serde_json::from_slice(bytes).expect("request is identifiable JSON");
    let object = value.as_object().expect("scope.open request is an object");
    assert_eq!(
        object.get("op").and_then(Value::as_str),
        Some("scope.open"),
        "refusal vector must identify scope.open"
    );

    let mut unknown = object
        .keys()
        .filter(|key| !matches!(key.as_str(), "op" | "P" | "agent"))
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(field) = unknown.first() {
        return refusal(field, "unknown field", RefusalReason::InvalidArguments);
    }

    for field in ["P", "agent"] {
        match object.get(field) {
            None => {
                return refusal(
                    field,
                    "required field is missing",
                    RefusalReason::InvalidArguments,
                );
            }
            Some(Value::String(value)) if value.is_empty() => {
                return refusal(field, "must be non-empty", RefusalReason::InvalidArguments);
            }
            Some(Value::String(_)) => {}
            Some(_) => {
                return refusal(field, "must be a string", RefusalReason::InvalidArguments);
            }
        }
    }
    panic!("request was schema-valid")
}

fn response_result(response: ScopeResponse) -> ScopeResult {
    match response {
        ScopeResponse::ScopeOpen { result } => result,
    }
}

fn expected_opened(expected: &SequenceExpected) -> ScopeResult {
    match expected {
        SequenceExpected::Opened {
            incarnation,
            lineage_id,
            resolve_generation,
            created,
        } => ScopeResult::Opened {
            incarnation: *incarnation,
            lineage_id: lineage_id.clone(),
            resolve_generation: *resolve_generation,
            created: *created,
        },
        _ => panic!("scope.open step must expect OPENED"),
    }
}

fn assert_scope_open_step(step: &SequenceStep) -> (ScopeRequest, ScopeResult) {
    let SequenceOperation::ScopeOpen {
        request_bytes_base64,
        ..
    } = &step.operation
    else {
        panic!("expected scope.open operation")
    };
    let request = parse_exact::<ScopeRequest>(request_bytes_base64, "scope.open request");
    let encoded_response = step
        .response_bytes_base64
        .as_deref()
        .expect("scope.open step has response bytes");
    let result = response_result(parse_exact::<ScopeResponse>(
        encoded_response,
        "scope.open response",
    ));
    assert_eq!(result, expected_opened(&step.expected));
    (request, result)
}

fn opened_fields(result: &ScopeResult) -> (u64, &str, u64, bool) {
    match result {
        ScopeResult::Opened {
            incarnation,
            lineage_id,
            resolve_generation,
            created,
        } => (*incarnation, lineage_id, *resolve_generation, *created),
        ScopeResult::Refused { .. } => panic!("expected OPENED result"),
    }
}

fn scope_request_fields(request: &ScopeRequest) -> (&str, &str) {
    match request {
        ScopeRequest::ScopeOpen {
            predecessor_key,
            agent,
        } => (predecessor_key, agent),
    }
}

fn valid_uuid36(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn assert_row_matches_open(row: &ScopeRow, request: &ScopeRequest, result: &ScopeResult) {
    let (predecessor_key, agent) = scope_request_fields(request);
    let (incarnation, lineage_id, resolve_generation, _) = opened_fields(result);
    assert_eq!(row.predecessor_key, predecessor_key);
    assert_eq!(row.agent, agent);
    assert_eq!(row.incarnation, incarnation);
    assert_eq!(row.lineage_id, lineage_id);
    assert_eq!(row.resolve_generation, resolve_generation);
}

fn assert_state_well_formed(state: &DurableState) {
    assert!(
        state.mc_attempt_rows.is_empty(),
        "fixture models no MC attempt row"
    );
    assert!(
        state.ticket_rows.is_empty(),
        "stateless tickets must not create durable ticket rows"
    );

    let mut scopes = BTreeSet::new();
    for row in &state.scope_rows {
        assert!(!row.predecessor_key.is_empty());
        assert!(!row.agent.is_empty());
        assert!(valid_uuid36(&row.lineage_id));
        assert!(row.incarnation <= state.owner_incarnation_counter);
        assert!(
            scopes.insert((&row.predecessor_key, &row.agent)),
            "duplicate durable scope row"
        );
        assert_eq!(
            state.owner_current_lineage.as_deref(),
            Some(row.lineage_id.as_str()),
            "scope row must use the owner's current lineage"
        );
    }

    let mut attempts = BTreeSet::new();
    for attempt in &state.gateway_attempts {
        assert!(attempts.insert(&attempt.attempt_id));
        assert!(!attempt.predecessor_key.is_empty());
        assert!(!attempt.agent.is_empty());
        assert!(!attempt.allocation_ref.is_empty());
        assert_eq!(attempt.fingerprint.digest.len(), 64);
        assert_eq!(attempt.fingerprint.normalization_version, 1);
        assert!(attempt.fingerprint.excluded_additions.is_empty());
        assert!(!attempt.ingress.boot_id.is_empty());
        assert!(attempt.ingress.sequence_seen >= attempt.ingress.watermark);
        assert!(!attempt.ingress.ownership_id.is_empty());
        assert_eq!(
            attempt.admission_ticket.predecessor_key,
            attempt.predecessor_key
        );
        assert_eq!(attempt.admission_ticket.agent, attempt.agent);
        assert_eq!(attempt.admission_ticket.incarnation, attempt.incarnation);
        assert!(attempt.ticket_cas_bound);
        assert_eq!(attempt.ticket_sample_count, 1);
        assert_eq!(attempt.obligation, "unresolved");
    }
}

fn assert_stale_refusal(expected: &SequenceExpected) {
    let SequenceExpected::Refused { refusal } = expected else {
        panic!("old-incarnation operation must be REFUSED")
    };
    assert_eq!(refusal.reason, RefusalReason::StaleIncarnation);
    assert_eq!(refusal.receipt_id, None);
    assert_eq!(
        refusal.details,
        RefusalDetails::Field {
            field: "incarnation".to_owned(),
            reason: "attempt incarnation differs from the current scope".to_owned(),
        }
    );
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn d5_scope_open_encodings_are_byte_exact() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.scope-open-vectors.v1");
    assert_eq!(fixture.contract_version, "1.3.18");
    assert!(fixture
        .encoding_rule
        .lineage_request
        .contains("discriminator op"));
    assert!(fixture
        .encoding_rule
        .lineage_request
        .contains("no args wrapper"));
    assert!(fixture
        .encoding_rule
        .lineage_response
        .contains("Externally keyed"));
    assert!(fixture
        .encoding_rule
        .nested_unions
        .contains("discriminator kind"));
    assert!(fixture
        .encoding_rule
        .nested_unions
        .contains("operation Option fields are omitted"));
    assert!(fixture
        .encoding_rule
        .nested_unions
        .contains("nested DTO Option fields are emitted as explicit null"));
    assert!(fixture.encoding_rule.nested_unions.contains("base64"));
    assert!(fixture
        .encoding_rule
        .unknown_keys
        .contains("invalid_arguments"));
    assert!(fixture
        .encoding_rule
        .implementation_status
        .contains("owner-authored"));

    assert_eq!(fixture.exact_encodings.len(), 4);
    assert_eq!(fixture.exact_encodings[0].id, "E01");
    assert_eq!(fixture.exact_encodings[0].message, "request");
    let request = parse_exact::<ScopeRequest>(
        &fixture.exact_encodings[0].bytes_base64,
        "exact request encoding",
    );
    assert_eq!(
        scope_request_fields(&request),
        ("session-fresh-0001", "agent-main")
    );

    let mut results = Vec::new();
    for (encoding, expected_id, expected_message) in [
        (
            &fixture.exact_encodings[1],
            "E02",
            "opened-created-response",
        ),
        (
            &fixture.exact_encodings[2],
            "E03",
            "opened-existing-response",
        ),
        (&fixture.exact_encodings[3], "E04", "refused-response"),
    ] {
        assert_eq!(encoding.id, expected_id);
        assert_eq!(encoding.message, expected_message);
        results.push(response_result(parse_exact::<ScopeResponse>(
            &encoding.bytes_base64,
            expected_message,
        )));
    }

    assert_eq!(
        opened_fields(&results[0]),
        (1, "30000000-0000-4000-8000-000000000001", 0, true)
    );
    assert_eq!(
        opened_fields(&results[1]),
        (1, "30000000-0000-4000-8000-000000000001", 0, false)
    );
    assert_eq!(
        results[2],
        ScopeResult::Refused {
            refusal: refusal(
                "P",
                "required field is missing",
                RefusalReason::InvalidArguments,
            ),
        }
    );
}

#[test]
fn d5_scope_open_invalid_requests_are_total_and_field_specific() {
    let (fixture, _) = load_fixture();
    let expected_ids = (1..=18)
        .map(|index| format!("R{index:02}"))
        .collect::<Vec<_>>();
    assert_eq!(
        fixture
            .refusal_vectors
            .iter()
            .map(|vector| vector.id.clone())
            .collect::<Vec<_>>(),
        expected_ids
    );

    let mut names = BTreeSet::new();
    for vector in &fixture.refusal_vectors {
        assert!(
            names.insert(vector.name.as_str()),
            "duplicate refusal vector name"
        );
        let request_bytes = wire_bytes(&vector.request_bytes_base64);
        let evaluated = invalid_request_refusal(&request_bytes);
        let expected_bytes = wire_bytes(&vector.expected_bytes_base64);
        let expected_value: Value =
            serde_json::from_slice(&expected_bytes).expect("scope.open refusal response JSON");
        assert!(
            expected_value["scope.open"]["result"]["refusal"]
                .as_object()
                .is_some_and(|refusal| refusal.get("receipt_id").is_some_and(Value::is_null)),
            "{} must emit absent nested DTO receipt_id as explicit null",
            vector.id
        );
        let expected = response_result(parse_exact::<ScopeResponse>(
            &vector.expected_bytes_base64,
            &vector.id,
        ));
        assert_eq!(
            expected,
            ScopeResult::Refused {
                refusal: evaluated.clone(),
            },
            "{} refusal does not match the independent validator",
            vector.id
        );
        assert_eq!(
            evaluated.details,
            RefusalDetails::Field {
                field: vector.field.clone(),
                reason: vector.reason.clone(),
            },
            "{} details",
            vector.id
        );
        assert_eq!(
            evaluated.receipt_id, None,
            "{} absent receipt_id must decode from explicit null",
            vector.id
        );
    }

    let wrong_type_names = fixture
        .refusal_vectors
        .iter()
        .filter(|vector| vector.name.contains("wrong"))
        .map(|vector| vector.name.as_str())
        .collect::<BTreeSet<_>>();
    let expected_wrong_types = ["null", "boolean", "integer", "array", "object"]
        .into_iter()
        .flat_map(|type_name| {
            ["P", "agent"]
                .into_iter()
                .map(move |field| format!("{field} has wrong {type_name} type"))
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        wrong_type_names,
        expected_wrong_types.iter().map(String::as_str).collect()
    );

    let unknown_fields = fixture
        .refusal_vectors
        .iter()
        .filter(|vector| vector.reason == "unknown field")
        .map(|vector| vector.field.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        unknown_fields,
        BTreeSet::from(["args", "incarnation", "lineage_id", "schema_version"])
    );
}

#[test]
fn d5_scope_open_fresh_scope_is_idempotent() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S01_fresh_scope");
    assert!(!sequence.name.is_empty());
    assert!(sequence.initial_state.scope_rows.is_empty());
    assert_eq!(sequence.initial_state.owner_incarnation_counter, 0);
    assert_eq!(sequence.steps.len(), 2);

    let (first_request, first_result) = assert_scope_open_step(&sequence.steps[0]);
    let (second_request, second_result) = assert_scope_open_step(&sequence.steps[1]);
    assert_eq!(first_request, second_request);
    let first = opened_fields(&first_result);
    let second = opened_fields(&second_result);
    assert!(first.3, "first scope.open must return created=true");
    assert!(!second.3, "second scope.open must return created=false");
    assert_eq!(first.0, second.0);
    assert_eq!(first.1, second.1);
    assert_eq!(first.2, second.2);
    assert!(valid_uuid36(first.1));
    assert_eq!(sequence.steps[0].state_after, sequence.steps[1].state_after);
    assert_eq!(sequence.steps[0].state_after.scope_rows.len(), 1);
    assert_eq!(sequence.steps[0].state_after.owner_incarnation_counter, 1);
    assert_row_matches_open(
        &sequence.steps[0].state_after.scope_rows[0],
        &first_request,
        &first_result,
    );
}

#[test]
fn d5_scope_open_existing_scope_retains_descent_lineage() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S02_existing_descent_lineage");
    assert!(!sequence.name.is_empty());
    assert_eq!(sequence.steps.len(), 1);
    let (request, result) = assert_scope_open_step(&sequence.steps[0]);
    let fields = opened_fields(&result);
    assert!(!fields.3, "existing scope must return created=false");
    assert_eq!(
        Some(fields.1),
        sequence.initial_state.owner_current_lineage.as_deref(),
        "scope.open must return the prior descent lineage"
    );
    assert_eq!(sequence.steps[0].state_after, sequence.initial_state);
    assert_eq!(sequence.initial_state.scope_rows.len(), 1);
    assert_row_matches_open(&sequence.initial_state.scope_rows[0], &request, &result);
}

#[test]
fn d5_scope_open_recreation_keeps_original_obligation() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S03_recreation_with_outstanding_attempt");
    let recreation = sequence
        .recreation_observation
        .as_ref()
        .expect("recreation observation");
    assert_eq!(
        recreation.current_incarnation,
        recreation.prior_incarnation + 1
    );
    assert!(recreation
        .resolve_generation_transition
        .contains("never resets"));
    assert_eq!(
        sequence.steps.len(),
        4,
        "recreation sequence must retain stale prepare and original resolve probes"
    );
    assert_eq!(sequence.initial_state.gateway_attempts.len(), 1);
    let original = &sequence.initial_state.gateway_attempts[0];
    assert_eq!(original.incarnation, recreation.prior_incarnation);
    assert!(original.ticket_cas_bound);
    assert_eq!(original.ticket_sample_count, 1);

    let (_, opened) = assert_scope_open_step(&sequence.steps[0]);
    let opened_fields = opened_fields(&opened);
    assert_eq!(opened_fields.0, recreation.current_incarnation);
    assert!(!opened_fields.3);

    let SequenceOperation::GatewayReconcile {
        attempt_id,
        opened_incarnation,
    } = &sequence.steps[1].operation
    else {
        panic!("second recreation step must reconcile")
    };
    assert_eq!(attempt_id, &original.attempt_id);
    assert_eq!(*opened_incarnation, recreation.current_incarnation);
    let SequenceExpected::FailClosed {
        record_preserved,
        obligation_intact,
        incarnation_adopted,
    } = &sequence.steps[1].expected
    else {
        panic!("reconcile must fail closed")
    };
    assert!(*record_preserved);
    assert!(*obligation_intact);
    assert!(!*incarnation_adopted);

    let SequenceOperation::Prepare {
        attempt_id,
        incarnation,
        admission_ticket,
    } = &sequence.steps[2].operation
    else {
        panic!("third recreation step must probe prepare")
    };
    assert_eq!(attempt_id, &original.attempt_id);
    assert_eq!(*incarnation, recreation.prior_incarnation);
    assert_eq!(admission_ticket, &original.admission_ticket);
    assert_stale_refusal(&sequence.steps[2].expected);

    let SequenceOperation::Resolve {
        attempt_id,
        incarnation,
        admission_ticket,
        original_ticket_used,
        new_ticket_sampled,
    } = &sequence.steps[3].operation
    else {
        panic!("fourth recreation step must resolve the original")
    };
    assert_eq!(attempt_id, &original.attempt_id);
    assert_eq!(*incarnation, recreation.prior_incarnation);
    assert_eq!(admission_ticket, &original.admission_ticket);
    assert!(*original_ticket_used);
    assert!(!*new_ticket_sampled);
    assert_stale_refusal(&sequence.steps[3].expected);

    for step in &sequence.steps {
        assert_eq!(
            step.state_after, sequence.initial_state,
            "recreation must preserve the old gateway record and obligation"
        );
    }
}

#[test]
fn d5_scope_open_recreation_never_decreases_generation() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S03_recreation_with_outstanding_attempt");
    let recreation = sequence
        .recreation_observation
        .as_ref()
        .expect("recreation observation");
    let before = &recreation.pre_recreation_scope_row;
    let after = sequence
        .initial_state
        .scope_rows
        .first()
        .expect("post-recreation scope row");
    let original = sequence
        .initial_state
        .gateway_attempts
        .first()
        .expect("original gateway attempt");

    assert_eq!(before.incarnation, recreation.prior_incarnation);
    assert_eq!(after.incarnation, recreation.current_incarnation);
    assert_eq!(before.predecessor_key, after.predecessor_key);
    assert_eq!(before.agent, after.agent);
    assert_eq!(before.lineage_id, after.lineage_id);
    assert_eq!(
        original.admission_ticket.predecessor_key,
        before.predecessor_key
    );
    assert_eq!(original.admission_ticket.agent, before.agent);
    assert_eq!(original.admission_ticket.incarnation, before.incarnation);
    assert_eq!(
        original.admission_ticket.resolve_generation, before.resolve_generation,
        "the original ticket must carry the generation sampled from the pre-recreation row"
    );
    assert!(
        after.resolve_generation >= before.resolve_generation,
        "resolve_generation must never decrease across recreation"
    );
    assert_eq!(
        after.resolve_generation, before.resolve_generation,
        "recreation without a seal or resolve must preserve resolve_generation"
    );
    for step in &sequence.steps {
        let row = step
            .state_after
            .scope_rows
            .first()
            .expect("post-recreation scope row remains durable");
        assert!(
            row.resolve_generation >= before.resolve_generation,
            "resolve_generation must remain monotonic after recreation"
        );
    }
}

#[test]
fn d5_scope_open_concurrent_calls_create_one_row() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S04_concurrent_fresh_opens");
    assert_eq!(sequence.all_invoked_before_first_completion, Some(true));
    let concurrent = sequence
        .concurrent_calls
        .as_ref()
        .expect("concurrent calls");
    assert_eq!(concurrent.len(), 4);
    assert_eq!(sequence.steps.len(), concurrent.len());

    let call_ids = concurrent
        .iter()
        .map(|call| call.call_id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(call_ids.len(), concurrent.len());
    let mut requests = BTreeSet::new();
    for call in concurrent {
        let request = parse_exact::<ScopeRequest>(
            &call.request_bytes_base64,
            "concurrent scope.open request",
        );
        let (predecessor_key, agent) = scope_request_fields(&request);
        requests.insert((predecessor_key.to_owned(), agent.to_owned()));
    }
    assert_eq!(requests.len(), 1);

    let mut completions = BTreeSet::new();
    let mut opened_rows = BTreeSet::new();
    let mut created_count = 0;
    for step in &sequence.steps {
        let SequenceOperation::ScopeOpen { call_id, .. } = &step.operation else {
            panic!("concurrent completion must be scope.open")
        };
        let call_id = call_id.as_deref().expect("completion call id");
        assert!(call_ids.contains(call_id));
        assert!(completions.insert(call_id));
        let (request, result) = assert_scope_open_step(step);
        let fields = opened_fields(&result);
        created_count += usize::from(fields.3);
        opened_rows.insert((fields.0, fields.1.to_owned(), fields.2));
        assert_eq!(
            step.state_after.scope_rows.len(),
            1,
            "every concurrent completion must observe exactly one durable scope row"
        );
        assert_row_matches_open(&step.state_after.scope_rows[0], &request, &result);
    }
    assert_eq!(completions, call_ids);
    assert_eq!(
        created_count, 1,
        "exactly one concurrent open creates the row"
    );
    assert_eq!(
        opened_rows.len(),
        1,
        "all concurrent opens return one row identity"
    );
}

#[test]
fn d5_scope_open_ticket_before_open_is_not_encodable() {
    let (fixture, _) = load_fixture();
    let sequence = sequence(&fixture, "S05_ticket_before_scope_open");
    assert!(sequence.initial_state.scope_rows.is_empty());
    assert_eq!(sequence.steps.len(), 1);
    let step = &sequence.steps[0];
    let SequenceOperation::AttemptTicket {
        arguments,
        request_encoding,
    } = &step.operation
    else {
        panic!("ordering vector must model attempt.ticket")
    };
    assert_eq!(arguments.predecessor_key, "session-ordering-0001");
    assert_eq!(arguments.agent, "agent-main");
    assert_eq!(request_encoding, "not_representable_without_incarnation");
    assert!(step.response_bytes_base64.is_none());
    let SequenceExpected::NotEncodable { field, reason } = &step.expected else {
        panic!("ticket-before-open must be NOT_ENCODABLE")
    };
    assert_eq!(field, "incarnation");
    assert!(reason.contains("returned by scope.open"));
    assert_eq!(step.state_after, sequence.initial_state);
    assert!(step.state_after.gateway_attempts.is_empty());
}

#[test]
fn d5_scope_open_sequence_states_are_well_formed() {
    let (fixture, _) = load_fixture();
    let expected = BTreeSet::from([
        "S01_fresh_scope",
        "S02_existing_descent_lineage",
        "S03_recreation_with_outstanding_attempt",
        "S04_concurrent_fresh_opens",
        "S05_ticket_before_scope_open",
    ]);
    assert_eq!(
        fixture
            .sequences
            .iter()
            .map(|sequence| sequence.id.as_str())
            .collect::<BTreeSet<_>>(),
        expected
    );
    for sequence in &fixture.sequences {
        assert!(!sequence.name.is_empty());
        assert_state_well_formed(&sequence.initial_state);
        for step in &sequence.steps {
            assert_state_well_formed(&step.state_after);
            if !matches!(step.operation, SequenceOperation::ScopeOpen { .. }) {
                assert!(
                    step.response_bytes_base64.is_none(),
                    "only scope.open operations carry exact response bytes"
                );
            }
        }
    }
}

#[test]
fn d5_scope_open_fixture_is_indexed() {
    let (fixture, fixture_bytes) = load_fixture();
    assert_eq!(fixture.generation.fixture_kind, "owner-authored");
    assert_eq!(fixture.generation.index_source, INDEX_SOURCE);
    assert_eq!(
        fixture.generation.generation_script,
        "packages/plugin/scripts/gen-d5-specimen-fixture.py"
    );

    let index_bytes =
        fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read D5 fixture index");
    let index: Value = serde_json::from_slice(&index_bytes).expect("parse D5 fixture index");
    let entry = index["files"]
        .as_array()
        .expect("index files")
        .iter()
        .find(|entry| entry["path"] == FIXTURE_NAME)
        .expect("scope.open fixture is indexed");
    assert_eq!(entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(entry["derived"], false);
    assert_eq!(entry["source"], INDEX_SOURCE);
    assert_eq!(
        entry["generation_script"],
        "packages/plugin/scripts/gen-d5-specimen-fixture.py"
    );
}
