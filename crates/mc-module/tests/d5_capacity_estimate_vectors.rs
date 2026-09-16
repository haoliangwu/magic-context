use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_NAME: &str = "capacity-estimate-vectors-v1.json";
const INDEX_SOURCE: &str = "owner-authored D5 capacity contract vectors";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    contract_version: String,
    encoding_rule: EncodingRule,
    constants: Constants,
    upload_records: Vec<UploadFixtureRecord>,
    capacity_begin_vectors: Vec<BeginVector>,
    capacity_check_vectors: Vec<CheckVector>,
    arithmetic_vectors: Vec<ArithmeticVector>,
    gateway_binding_vectors: Vec<GatewayBindingVector>,
    capacity_lifecycle_vectors: Vec<CapacityLifecycleVector>,
    capacity_check_key_vectors: Vec<CapacityCheckKeyVector>,
    capacity_reupload_vectors: Vec<CapacityReuploadVector>,
    checked_result_eviction_vectors: Vec<CheckedResultEvictionVector>,
    capacity_supersession_vectors: Vec<CapacitySupersessionVector>,
    upload_authorization_vectors: Vec<UploadAuthorizationVector>,
    unsettled_24a_ambiguities: Vec<String>,
    generation: Generation,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    lineage_request: String,
    lineage_response: String,
    nested_unions: String,
    token_counts: String,
    implementation_status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Constants {
    inline_body_limit_bytes: u64,
    estimator: EstimatorIdentity,
    model: String,
    max_open_uploads_per_scope: u64,
    max_bytes_per_upload: u64,
    max_chunk_bytes: u64,
    accepted_seq_counts_once: bool,
    upload_accounting_scope: String,
    max_checked_results_per_scope: u64,
    checked_result_eviction: String,
    max_retained_staged_bytes_per_scope: u64,
    consumption_frees_staged_bytes: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct UploadRef {
    upload_id: String,
    digest: String,
    total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UploadState {
    Open,
    Finished,
    Consumed,
    Superseded,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct UploadFixtureRecord {
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    #[serde(rename = "ref")]
    upload_ref: UploadRef,
    total_chunks: u64,
    state: UploadState,
    declared_model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BeginUploadRecord {
    #[serde(rename = "P")]
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    upload_id: String,
    digest: String,
    total_bytes: u64,
    total_chunks: u64,
    state: UploadState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BeginVector {
    id: String,
    name: String,
    initial_records: Vec<BeginUploadRecord>,
    request_bytes_base64: String,
    expected_bytes_base64: String,
    state_after: Vec<BeginUploadRecord>,
    replayed_finished_ref: Option<UploadRef>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CheckVector {
    id: String,
    name: String,
    request_bytes_base64: String,
    expected_bytes_base64: String,
    arithmetic_vector_id: Option<String>,
    estimator_available: bool,
    geometry_matches: bool,
    refusal_body_bytes_read: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ArithmeticVector {
    id: String,
    check_vector_id: String,
    expected_fit_soft: Option<u64>,
    expected_hard_required: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GatewayBindingVector {
    id: String,
    check_vector_id: String,
    candidate_body_sha256: String,
    expected: GatewayExpected,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CapacityLifecycleVector {
    id: String,
    name: String,
    initial_record: UploadFixtureRecord,
    first_request_bytes_base64: String,
    first_checked_bytes_base64: String,
    replay_request_bytes_base64: String,
    replay_checked_bytes_base64: String,
    re_tokenized: bool,
    replay_key: Vec<String>,
    original_body_bytes_base64: Option<String>,
    retained_staged_bytes: u64,
    checked_result_cache_entries: u64,
    checked_result_cache_limit: u64,
    matching_complete_check_key: bool,
    expected_source: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CapacityCheckKeyVector {
    id: String,
    base_check_vector_id: String,
    comparison_check_vector_id: String,
    same_body_sha256: bool,
    same_complete_check_key: bool,
    expected: CheckKeyExpected,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CheckKeyExpected {
    ByteIdenticalReplay,
    NewEstimate,
    InvalidArgumentsModel,
    CheckedWithArgumentModel,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CapacityReuploadVector {
    id: String,
    changed_check_input: String,
    consumed_ref: UploadRef,
    replacement_ref: UploadRef,
    check_vector_id: String,
    reupload_required: bool,
    original_body_bytes_base64: Option<String>,
    retained_staged_bytes_before_reupload: u64,
    consumed_check_request_bytes_base64: String,
    expected_consumed_check_bytes_base64: String,
    replacement_state_before_check: UploadState,
    replacement_state_after_check: UploadState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CheckedResultEvictionVector {
    id: String,
    capacity: u64,
    policy: String,
    initial_entries: Vec<CheckedCacheEntry>,
    ninth_entry: CheckedCacheEntry,
    evicted_check_key_sha256: String,
    entries_after: Vec<CheckedCacheEntry>,
    evicted_replay_requires_fresh_upload: bool,
    original_body_bytes_base64: Option<String>,
    retained_staged_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CheckedCacheEntry {
    check_key_sha256: String,
    checked_at_order: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CapacitySupersessionVector {
    id: String,
    begin_vector_id: String,
    state_after_begin: Vec<BeginUploadRecord>,
    older_body_bytes_base64: Option<String>,
    state_before_check: Vec<BeginUploadRecord>,
    newer_check_vector_id: String,
    state_after_check: Vec<BeginUploadRecord>,
    newer_body_bytes_base64: Option<String>,
    late_operations: Vec<LateSupersededOperation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LateSupersededOperation {
    operation: String,
    upload_id: String,
    expected_refusal: Refusal,
    newer_upload_unchanged: bool,
    bytes_read: u64,
    request_bytes_base64: Option<String>,
    expected_bytes_base64: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct UploadAuthorizationVector {
    id: String,
    op: UploadOperation,
    upload_kind: UploadKind,
    caller_kind: CallerKind,
    ticket_present: bool,
    request_bytes_base64: String,
    expected: UploadAuthorizationExpected,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
enum UploadOperation {
    #[serde(rename = "capacity.put")]
    CapacityPut,
    #[serde(rename = "capacity.finish")]
    CapacityFinish,
    #[serde(rename = "lineage.put")]
    LineagePut,
    #[serde(rename = "lineage.finish")]
    LineageFinish,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UploadKind {
    Capacity,
    Lineage,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CallerKind {
    CapacityScope,
    LineageTicketBound,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum UploadAuthorizationExpected {
    Authorized { refusal: Option<Refusal> },
    Refused { refusal: Refusal },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GatewayExpected {
    kind: GatewayKind,
    error_code: Option<String>,
    custody_preserved: bool,
    check_again: bool,
    #[serde(default)]
    successor_overflow: Option<SuccessorOverflow>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum GatewayKind {
    Send,
    CheckAgain,
    PreservationUnavailable,
    PostSealOverflow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Generation {
    fixture_kind: String,
    index_source: String,
    generation_script: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "op", deny_unknown_fields)]
enum LineageRequest {
    #[serde(rename = "capacity.begin")]
    CapacityBegin {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        total_bytes: u64,
        total_chunks: u64,
        digest: String,
        // Clause 3a option convention: None is omitted on the wire and a present
        // `null` is rejected, matching ResolveRequest. `deserialize_with` refuses null.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "reject_null_option"
        )]
        expected_open: Option<String>,
    },
    #[serde(rename = "capacity.put")]
    CapacityPut {
        upload_id: String,
        seq: u64,
        bytes: String,
    },
    #[serde(rename = "capacity.finish")]
    CapacityFinish { upload_id: String, digest: String },
    #[serde(rename = "lineage.put")]
    LineagePut {
        upload_id: String,
        seq: u64,
        bytes: String,
    },
    #[serde(rename = "lineage.finish")]
    LineageFinish { upload_id: String, digest: String },
    #[serde(rename = "capacity.check")]
    CapacityCheck {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        body: CapacityBody,
        model: String,
        geometry: GeometryV1,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
enum LineageResponse {
    #[serde(rename = "capacity.begin")]
    Begin { result: BeginResult },
    #[serde(rename = "capacity.put")]
    Put { result: PutResult },
    #[serde(rename = "capacity.finish")]
    Finish { result: FinishResult },
    #[serde(rename = "capacity.check")]
    Check { result: CapacityResult },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CapacityBody {
    Inline {
        bytes: String,
    },
    Upload {
        #[serde(rename = "ref")]
        upload_ref: UploadRef,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum BeginResult {
    #[serde(rename = "BEGUN")]
    Begun { upload_id: String },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum CapacityResult {
    #[serde(rename = "CHECKED")]
    Checked { estimate: CapacityEstimateV1 },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum PutResult {
    #[serde(rename = "STORED")]
    Stored { seq: u64, chunk_digest: String },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
enum FinishResult {
    #[serde(rename = "FINISHED")]
    Finished { upload: UploadRef },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CapacityEstimateV1 {
    schema_version: u64,
    body_sha256: String,
    body_bytes: u64,
    model: String,
    geometry_wire: GeometryV1,
    reserve_accounting: ReserveAccounting,
    estimator: EstimatorIdentity,
    #[serde(rename = "X")]
    x: u64,
    #[serde(rename = "R")]
    reserve: KnownReserve,
    soft_bounded: u64,
    fit: CapacityFit,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GeometryV1 {
    usable_soft: u64,
    usable_hard: u64,
    absolute_wall: Option<u64>,
    derivation: String,
    reserve_accounting: ReserveAccounting,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum ReserveAccounting {
    OnceCarved,
    NoneDeclared,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EstimatorIdentity {
    identity: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum KnownReserve {
    Known { value: ReserveRecord },
    Unknown { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReserveRecord {
    model: String,
    tokens: u64,
    source: ReserveSource,
    units: TokenUnits,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ReserveSource {
    WindowGeometry,
    Config,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TokenUnits {
    Tokens,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CapacityFit {
    Fits,
    Overflow { hard_required: u64 },
    Unknown { reason: CapacityUnknownReason },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum CapacityUnknownReason {
    ReserveUnknown,
    EstimatorUnavailable,
    GeometryMismatch,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Refusal {
    reason: RefusalReason,
    receipt_id: Option<String>,
    details: RefusalDetails,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalReason {
    InvalidArguments,
    ByteCap,
    UploadConflict,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RefusalDetails {
    Field {
        field: String,
        reason: String,
    },
    Cap {
        cap: String,
        actual: u64,
        limit: u64,
        units: String,
    },
    Live {
        upload_id: String,
        digest: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SuccessorOverflow {
    SuccessorOverflow {
        estimated: u64,
        actual: u64,
        actual_source: ActualSource,
        usable_hard: u64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ActualSource {
    McEstimate,
    Provider,
}

/// Clause 3a: an absent option is omitted; a present JSON `null` is a malformed request.
fn reject_null_option<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Err(serde::de::Error::custom(
            "expected_open must be omitted when absent; null is not accepted",
        )),
        Value::String(text) => Ok(Some(text)),
        other => Err(serde::de::Error::custom(format!(
            "expected_open must be a string, got {other}"
        ))),
    }
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join(FIXTURE_NAME)).expect("read capacity vectors");
    let fixture = serde_json::from_slice(&bytes).expect("parse capacity fixture schema");
    (fixture, bytes)
}

fn begin_vector<'a>(fixture: &'a Fixture, id: &str) -> &'a BeginVector {
    fixture
        .capacity_begin_vectors
        .iter()
        .find(|vector| vector.id == id)
        .unwrap_or_else(|| panic!("missing begin vector {id}"))
}

fn check_vector<'a>(fixture: &'a Fixture, id: &str) -> &'a CheckVector {
    fixture
        .capacity_check_vectors
        .iter()
        .find(|vector| vector.id == id)
        .unwrap_or_else(|| panic!("missing check vector {id}"))
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

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
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
        serde_json::to_vec(&value).expect("serialize wire value"),
        bytes,
        "{label} must re-serialize byte-identically"
    );
    value
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn request_check(
    request: LineageRequest,
) -> (String, String, u64, CapacityBody, String, GeometryV1) {
    match request {
        LineageRequest::CapacityCheck {
            predecessor_key,
            agent,
            incarnation,
            body,
            model,
            geometry,
        } => (predecessor_key, agent, incarnation, body, model, geometry),
        _ => panic!("expected capacity.check request"),
    }
}

fn response_check(response: LineageResponse) -> CapacityResult {
    match response {
        LineageResponse::Check { result } => result,
        _ => panic!("expected capacity.check response"),
    }
}

fn request_begin(
    request: LineageRequest,
) -> (String, String, u64, u64, u64, String, Option<String>) {
    match request {
        LineageRequest::CapacityBegin {
            predecessor_key,
            agent,
            incarnation,
            total_bytes,
            total_chunks,
            digest,
            expected_open,
        } => (
            predecessor_key,
            agent,
            incarnation,
            total_bytes,
            total_chunks,
            digest,
            expected_open,
        ),
        _ => panic!("expected capacity.begin request"),
    }
}

fn response_begin(response: LineageResponse) -> BeginResult {
    match response {
        LineageResponse::Begin { result } => result,
        _ => panic!("expected capacity.begin response"),
    }
}

fn upload_operation(request: LineageRequest) -> (UploadOperation, String) {
    match request {
        LineageRequest::CapacityPut {
            upload_id,
            seq,
            bytes,
        } => {
            assert_eq!(seq, 0);
            assert_eq!(wire_bytes(&bytes), b"x");
            (UploadOperation::CapacityPut, upload_id)
        }
        LineageRequest::CapacityFinish { upload_id, digest } => {
            assert!(valid_digest(&digest));
            (UploadOperation::CapacityFinish, upload_id)
        }
        LineageRequest::LineagePut {
            upload_id,
            seq,
            bytes,
        } => {
            assert_eq!(seq, 0);
            assert_eq!(wire_bytes(&bytes), b"x");
            (UploadOperation::LineagePut, upload_id)
        }
        LineageRequest::LineageFinish { upload_id, digest } => {
            assert!(valid_digest(&digest));
            (UploadOperation::LineageFinish, upload_id)
        }
        _ => panic!("expected capacity or lineage upload operation"),
    }
}

fn refused_upload_response(response: LineageResponse) -> Refusal {
    match response {
        LineageResponse::Put {
            result: PutResult::Refused { refusal },
        }
        | LineageResponse::Finish {
            result: FinishResult::Refused { refusal },
        } => refusal,
        _ => panic!("expected refused capacity upload response"),
    }
}

fn parsed_check(vector: &CheckVector) -> (LineageRequest, CapacityResult) {
    (
        parse_exact(
            &vector.request_bytes_base64,
            &format!("{} request", vector.id),
        ),
        response_check(parse_exact(
            &vector.expected_bytes_base64,
            &format!("{} response", vector.id),
        )),
    )
}

fn checked_estimate(vector: &CheckVector) -> CapacityEstimateV1 {
    let (_, result) = parsed_check(vector);
    match result {
        CapacityResult::Checked { estimate } => estimate,
        CapacityResult::Refused { .. } => panic!("{} must be CHECKED", vector.id),
    }
}

fn reserve_tokens(reserve: &KnownReserve) -> Option<u64> {
    match reserve {
        KnownReserve::Known { value } => Some(value.tokens),
        KnownReserve::Unknown { .. } => None,
    }
}

fn evaluate_fit(vector: &CheckVector, estimate: &CapacityEstimateV1) -> CapacityFit {
    if !vector.geometry_matches {
        return CapacityFit::Unknown {
            reason: CapacityUnknownReason::GeometryMismatch,
        };
    }
    if !vector.estimator_available {
        return CapacityFit::Unknown {
            reason: CapacityUnknownReason::EstimatorUnavailable,
        };
    }
    let Some(reserve) = reserve_tokens(&estimate.reserve) else {
        return CapacityFit::Unknown {
            reason: CapacityUnknownReason::ReserveUnknown,
        };
    };
    let fit_soft = match estimate.reserve_accounting {
        ReserveAccounting::OnceCarved => estimate.soft_bounded,
        ReserveAccounting::NoneDeclared => estimate
            .soft_bounded
            .checked_sub(reserve)
            .expect("R cannot exceed soft_bounded in a CHECKED estimate"),
    };
    let hard_required = estimate.x.checked_add(reserve).expect("X + R cannot wrap");
    if estimate.x <= fit_soft && hard_required <= estimate.geometry_wire.usable_hard {
        CapacityFit::Fits
    } else {
        CapacityFit::Overflow { hard_required }
    }
}

fn field_refusal(field: &str, reason: &str) -> Refusal {
    Refusal {
        reason: RefusalReason::InvalidArguments,
        receipt_id: None,
        details: RefusalDetails::Field {
            field: field.to_owned(),
            reason: reason.to_owned(),
        },
    }
}

fn evaluate_begin(
    fixture: &Fixture,
    vector: &BeginVector,
    request: &LineageRequest,
) -> BeginResult {
    let (predecessor, agent, incarnation, total_bytes, total_chunks, digest, expected_open) =
        request_begin(request.clone());
    if total_bytes > fixture.constants.max_bytes_per_upload {
        return BeginResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::ByteCap,
                receipt_id: None,
                details: RefusalDetails::Cap {
                    cap: "capacity_upload".to_owned(),
                    actual: total_bytes,
                    limit: fixture.constants.max_bytes_per_upload,
                    units: "bytes".to_owned(),
                },
            },
        };
    }

    let mut live = None;
    let mut consumed_same_digest = Vec::new();
    for record in vector.initial_records.iter().filter(|record| {
        record.predecessor_key == predecessor
            && record.agent == agent
            && record.incarnation == incarnation
    }) {
        match record.state {
            UploadState::Open | UploadState::Finished => {
                assert!(
                    live.replace(record).is_none(),
                    "capacity scope must have at most one live upload"
                );
            }
            UploadState::Consumed if record.digest == digest => {
                consumed_same_digest.push(record);
            }
            UploadState::Consumed | UploadState::Superseded => {}
        }
    }

    if let Some(live) = live {
        if live.digest == digest {
            if live.total_bytes != total_bytes || live.total_chunks != total_chunks {
                let field = if live.total_bytes != total_bytes {
                    "total_bytes"
                } else {
                    "total_chunks"
                };
                return BeginResult::Refused {
                    refusal: field_refusal(
                        field,
                        "declaration differs from the open capacity upload",
                    ),
                };
            }
            return BeginResult::Begun {
                upload_id: live.upload_id.clone(),
            };
        }

        if expected_open.as_deref() != Some(live.upload_id.as_str()) {
            return BeginResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::UploadConflict,
                    receipt_id: None,
                    details: RefusalDetails::Live {
                        upload_id: live.upload_id.clone(),
                        digest: live.digest.clone(),
                    },
                },
            };
        }
        let replacement = vector
            .state_after
            .iter()
            .find(|record| {
                record.predecessor_key == predecessor
                    && record.agent == agent
                    && record.incarnation == incarnation
                    && record.digest == digest
                    && record.total_bytes == total_bytes
                    && record.total_chunks == total_chunks
                    && record.state == UploadState::Open
                    && record.upload_id != live.upload_id
            })
            .expect("different digest must create a superseding live upload");
        assert!(vector.state_after.iter().any(|record| {
            record.upload_id == live.upload_id && record.state == UploadState::Superseded
        }));
        return BeginResult::Begun {
            upload_id: replacement.upload_id.clone(),
        };
    }

    if expected_open.is_some() {
        return BeginResult::Refused {
            refusal: field_refusal("expected_open", "no open upload"),
        };
    }
    let replacement = vector
        .state_after
        .iter()
        .find(|record| {
            record.predecessor_key == predecessor
                && record.agent == agent
                && record.incarnation == incarnation
                && record.digest == digest
                && record.total_bytes == total_bytes
                && record.total_chunks == total_chunks
                && record.state == UploadState::Open
        })
        .expect("fresh begin must create its declared live record");
    assert!(
        consumed_same_digest
            .iter()
            .all(|consumed| consumed.upload_id != replacement.upload_id),
        "consumed digest begin must allocate a new live upload"
    );
    BeginResult::Begun {
        upload_id: replacement.upload_id.clone(),
    }
}

fn upload_record_matches(
    record: &UploadFixtureRecord,
    predecessor: &str,
    agent: &str,
    incarnation: u64,
    upload_ref: &UploadRef,
) -> bool {
    record.predecessor_key == predecessor
        && record.agent == agent
        && record.incarnation == incarnation
        && record.upload_ref == *upload_ref
}

fn checked_body_binding(
    fixture: &Fixture,
    request: &LineageRequest,
) -> Result<(String, u64), Refusal> {
    let (predecessor, agent, incarnation, body, model, _) = request_check(request.clone());
    if model.is_empty() {
        return Err(field_refusal("model", "must be non-empty"));
    }
    match body {
        CapacityBody::Inline { bytes } => {
            let bytes = wire_bytes(&bytes);
            if bytes.len() as u64 > fixture.constants.inline_body_limit_bytes {
                return Err(Refusal {
                    reason: RefusalReason::ByteCap,
                    receipt_id: None,
                    details: RefusalDetails::Cap {
                        cap: "inline_body".to_owned(),
                        actual: bytes.len() as u64,
                        limit: fixture.constants.inline_body_limit_bytes,
                        units: "bytes".to_owned(),
                    },
                });
            }
            Ok((sha256_hex(&bytes), bytes.len() as u64))
        }
        CapacityBody::Upload { upload_ref } => {
            let record = fixture.upload_records.iter().find(|record| {
                upload_record_matches(record, &predecessor, &agent, incarnation, &upload_ref)
            });
            match record {
                Some(record)
                    if record.state == UploadState::Finished
                        && record
                            .declared_model
                            .as_ref()
                            .is_some_and(|declared| declared != &model) =>
                {
                    Err(field_refusal(
                        "model",
                        "model does not match the model declared by the final body",
                    ))
                }
                Some(record) if record.state == UploadState::Finished => {
                    Ok((upload_ref.digest, upload_ref.total_bytes))
                }
                Some(_) => Err(field_refusal("ref", "capacity upload is not finished")),
                None if fixture
                    .upload_records
                    .iter()
                    .any(|record| record.upload_ref == upload_ref) =>
                {
                    Err(field_refusal(
                        "ref",
                        "capacity upload ref is not owned by this scope",
                    ))
                }
                None => Err(field_refusal("ref", "capacity upload ref is unknown")),
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CanonicalCheckKey {
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    body_sha256: String,
    model: String,
    geometry_wire: GeometryV1,
    reserve_accounting: ReserveAccounting,
    estimator: EstimatorIdentity,
}

fn body_sha256(body: &CapacityBody) -> String {
    match body {
        CapacityBody::Inline { bytes } => sha256_hex(&wire_bytes(bytes)),
        CapacityBody::Upload { upload_ref } => upload_ref.digest.clone(),
    }
}

fn canonical_check_key(
    request: &LineageRequest,
    estimate: &CapacityEstimateV1,
) -> CanonicalCheckKey {
    let (predecessor_key, agent, incarnation, body, model, geometry_wire) =
        request_check(request.clone());
    let body_sha256 = body_sha256(&body);
    assert_eq!(body_sha256, estimate.body_sha256);
    assert_eq!(model, estimate.model);
    assert_eq!(geometry_wire, estimate.geometry_wire);
    CanonicalCheckKey {
        predecessor_key,
        agent,
        incarnation,
        body_sha256,
        model,
        geometry_wire,
        reserve_accounting: estimate.reserve_accounting,
        estimator: estimate.estimator.clone(),
    }
}

fn gateway_outcome(estimate: &CapacityEstimateV1, candidate_digest: &str) -> GatewayExpected {
    if candidate_digest != estimate.body_sha256 {
        return GatewayExpected {
            kind: GatewayKind::CheckAgain,
            error_code: None,
            custody_preserved: true,
            check_again: true,
            successor_overflow: None,
        };
    }
    match estimate.fit {
        CapacityFit::Fits => GatewayExpected {
            kind: GatewayKind::Send,
            error_code: None,
            custody_preserved: true,
            check_again: false,
            successor_overflow: None,
        },
        CapacityFit::Unknown { .. } => GatewayExpected {
            kind: GatewayKind::PreservationUnavailable,
            error_code: Some("d5_preservation_unavailable".to_owned()),
            custody_preserved: true,
            check_again: false,
            successor_overflow: None,
        },
        CapacityFit::Overflow { hard_required } => GatewayExpected {
            kind: GatewayKind::PostSealOverflow,
            error_code: Some("d5_post_seal_overflow".to_owned()),
            custody_preserved: true,
            check_again: false,
            successor_overflow: Some(SuccessorOverflow::SuccessorOverflow {
                estimated: hard_required,
                actual: estimate.x,
                actual_source: ActualSource::McEstimate,
                usable_hard: estimate.geometry_wire.usable_hard,
            }),
        },
    }
}

#[test]
fn d5_capacity_encodings_are_byte_exact() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.capacity-estimate-vectors.v1");
    assert_eq!(fixture.contract_version, "1.3.26");
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
    assert!(fixture.encoding_rule.nested_unions.contains("Known<T>"));
    assert!(fixture
        .encoding_rule
        .nested_unions
        .contains("ref:UploadRef"));
    assert!(fixture
        .encoding_rule
        .token_counts
        .contains("checked nonnegative"));
    assert!(fixture.encoding_rule.token_counts.contains("base64"));
    assert!(fixture
        .encoding_rule
        .implementation_status
        .contains("owner-authored"));
    assert_eq!(fixture.constants.inline_body_limit_bytes, 1_048_576);
    assert_eq!(fixture.constants.max_open_uploads_per_scope, 1);
    assert_eq!(fixture.constants.max_bytes_per_upload, 64 * 1_048_576);
    assert_eq!(fixture.constants.max_chunk_bytes, 1_048_576);
    assert!(fixture.constants.accepted_seq_counts_once);
    assert_eq!(fixture.constants.upload_accounting_scope, "scope");
    assert_eq!(fixture.constants.max_checked_results_per_scope, 8);
    assert_eq!(
        fixture.constants.checked_result_eviction,
        "lru_by_check_time"
    );
    assert_eq!(
        fixture.constants.max_retained_staged_bytes_per_scope,
        64 * 1_048_576
    );
    assert!(fixture.constants.consumption_frees_staged_bytes);
    assert_eq!(fixture.constants.estimator.identity, "mc-tokenizer");
    assert_eq!(fixture.constants.estimator.version, "711b097e");
    assert_eq!(
        fixture.constants.model,
        "anthropic/claude-sonnet-4-20250514"
    );

    let mut ids = BTreeSet::new();
    for vector in &fixture.capacity_begin_vectors {
        assert!(ids.insert(vector.id.as_str()));
        assert!(!vector.name.is_empty());
        let _: LineageRequest = parse_exact(&vector.request_bytes_base64, &vector.id);
        let _: LineageResponse = parse_exact(&vector.expected_bytes_base64, &vector.id);
    }
    for vector in &fixture.capacity_check_vectors {
        assert!(ids.insert(vector.id.as_str()));
        assert!(!vector.name.is_empty());
        let (request, result) = parsed_check(vector);
        if let CapacityResult::Checked { estimate } = result {
            assert_eq!(estimate.schema_version, 1);
            assert!(valid_digest(&estimate.body_sha256));
            assert_eq!(
                estimate.estimator.identity,
                fixture.constants.estimator.identity
            );
            assert!(matches!(
                estimate.estimator.version.as_str(),
                "711b097e" | "711b097f"
            ));
            let (_, _, _, _, model, geometry) = request_check(request);
            assert_eq!(estimate.model, model);
            assert_eq!(estimate.geometry_wire, geometry);
            assert_eq!(estimate.reserve_accounting, geometry.reserve_accounting);
            assert_eq!(
                estimate.soft_bounded,
                geometry.usable_soft.min(geometry.usable_hard)
            );
            if let KnownReserve::Known { value } = &estimate.reserve {
                assert_eq!(value.model, estimate.model);
                assert_eq!(value.units, TokenUnits::Tokens);
            }
            assert!(matches!(
                estimate.model.as_str(),
                "anthropic/claude-sonnet-4-20250514" | "anthropic/claude-opus-4-8"
            ));
        }
    }
}

#[test]
fn d5_capacity_begin_is_ticketless_idempotent_and_single_open() {
    let (fixture, _) = load_fixture();
    assert_eq!(
        fixture
            .capacity_begin_vectors
            .iter()
            .map(|vector| vector.id.as_str())
            .collect::<Vec<_>>(),
        [
            "B01_fresh",
            "B02_idempotent_replay",
            "B03_changed_totals_refuse",
            "B04_different_digest_supersedes_open",
            "B05_consumed_same_digest_allocates_new",
            "B07_max_bytes_refuses",
            "B08_delayed_a_none_refuses_live_b",
            "B09_a_expected_b_supersedes",
            "B10_b_none_refuses_live_a",
            "B11_expected_open_without_live_refuses",
            "B12_consumed_a_none_refuses_live_b",
            "B13_consumed_a_expected_b_supersedes",
        ]
    );

    for vector in &fixture.capacity_begin_vectors {
        let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
        let expected = response_begin(parse_exact::<LineageResponse>(
            &vector.expected_bytes_base64,
            &vector.id,
        ));
        assert_eq!(
            evaluate_begin(&fixture, vector, &request),
            expected,
            "{}",
            vector.id
        );
        assert!(vector.initial_records.iter().all(|record| {
            valid_digest(&record.digest) && record.total_bytes > 0 && record.total_chunks > 0
        }));
        assert!(
            vector
                .initial_records
                .iter()
                .filter(|record| record.state == UploadState::Open)
                .count()
                <= fixture.constants.max_open_uploads_per_scope as usize
        );
        assert!(
            vector
                .state_after
                .iter()
                .filter(|record| record.state == UploadState::Open)
                .count()
                <= fixture.constants.max_open_uploads_per_scope as usize
        );
        if matches!(expected, BeginResult::Refused { .. }) {
            assert_eq!(vector.state_after, vector.initial_records, "{}", vector.id);
        }
        if let BeginResult::Refused { refusal } = expected {
            assert_eq!(refusal.receipt_id, None, "{}", vector.id);
        }
    }

    let fresh = begin_vector(&fixture, "B01_fresh");
    let replay = begin_vector(&fixture, "B02_idempotent_replay");
    assert!(fresh.initial_records.is_empty());
    assert_eq!(fresh.state_after, replay.initial_records);
    assert_eq!(fresh.expected_bytes_base64, replay.expected_bytes_base64);

    let consumed = begin_vector(&fixture, "B05_consumed_same_digest_allocates_new");
    assert_eq!(consumed.replayed_finished_ref, None);
    assert_eq!(consumed.initial_records[0].state, UploadState::Consumed);
    assert_eq!(consumed.state_after[0], consumed.initial_records[0]);
    assert_eq!(consumed.state_after[1].state, UploadState::Open);
    assert_eq!(
        consumed.state_after[1].digest,
        consumed.initial_records[0].digest
    );
    assert_ne!(
        consumed.state_after[1].upload_id,
        consumed.initial_records[0].upload_id
    );
}

#[test]
fn d5_capacity_begin_supersession_is_cas_guarded() {
    let (fixture, _) = load_fixture();
    let replay = begin_vector(&fixture, "B02_idempotent_replay");
    let replay_request = parse_exact::<LineageRequest>(&replay.request_bytes_base64, &replay.id);
    let (_, _, _, _, _, replay_digest, replay_expected_open) = request_begin(replay_request);
    assert_eq!(replay_digest, replay.initial_records[0].digest);
    assert_eq!(
        replay_expected_open.as_deref(),
        Some("stale-open-is-ignored")
    );
    assert!(matches!(
        response_begin(parse_exact::<LineageResponse>(
            &replay.expected_bytes_base64,
            &replay.id,
        )),
        BeginResult::Begun { .. }
    ));

    let supersede = begin_vector(&fixture, "B04_different_digest_supersedes_open");
    let request = parse_exact::<LineageRequest>(&supersede.request_bytes_base64, &supersede.id);
    let (_, _, _, _, _, digest, expected_open) = request_begin(request);
    assert_ne!(digest, supersede.initial_records[0].digest);
    assert_eq!(
        expected_open.as_deref(),
        Some(supersede.initial_records[0].upload_id.as_str())
    );
    assert_eq!(supersede.state_after[0].state, UploadState::Superseded);
    assert_eq!(supersede.state_after[1].state, UploadState::Open);

    for id in [
        "B08_delayed_a_none_refuses_live_b",
        "B10_b_none_refuses_live_a",
    ] {
        let vector = begin_vector(&fixture, id);
        let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
        let (_, _, _, _, _, digest, expected_open) = request_begin(request);
        let live = vector
            .initial_records
            .iter()
            .find(|record| matches!(record.state, UploadState::Open | UploadState::Finished))
            .expect("conflict vector must include its live upload");
        assert_ne!(digest, live.digest);
        assert_eq!(expected_open, None);
        let result = response_begin(parse_exact::<LineageResponse>(
            &vector.expected_bytes_base64,
            &vector.id,
        ));
        let BeginResult::Refused { refusal } = result else {
            panic!("{id} must refuse stale expected_open")
        };
        assert_eq!(refusal.reason, RefusalReason::UploadConflict);
        assert_eq!(refusal.receipt_id, None);
        assert_eq!(
            refusal.details,
            RefusalDetails::Live {
                upload_id: live.upload_id.clone(),
                digest: live.digest.clone(),
            }
        );
        assert_eq!(vector.state_after, vector.initial_records);
    }

    let no_live = begin_vector(&fixture, "B11_expected_open_without_live_refuses");
    assert!(no_live.initial_records.is_empty());
    assert!(no_live.state_after.is_empty());
    let request = parse_exact::<LineageRequest>(&no_live.request_bytes_base64, &no_live.id);
    let (_, _, _, _, _, _, expected_open) = request_begin(request);
    assert_eq!(expected_open.as_deref(), Some("capacity-begin-upload-old"));
    assert_eq!(
        response_begin(parse_exact::<LineageResponse>(
            &no_live.expected_bytes_base64,
            &no_live.id,
        )),
        BeginResult::Refused {
            refusal: field_refusal("expected_open", "no open upload"),
        }
    );

    let return_to_a = begin_vector(&fixture, "B09_a_expected_b_supersedes");
    let request = parse_exact::<LineageRequest>(&return_to_a.request_bytes_base64, &return_to_a.id);
    let (_, _, _, _, _, digest, expected_open) = request_begin(request);
    assert_ne!(digest, return_to_a.initial_records[0].digest);
    assert_eq!(
        expected_open.as_deref(),
        Some(return_to_a.initial_records[0].upload_id.as_str())
    );
    assert_eq!(return_to_a.state_after[0].state, UploadState::Superseded);
    assert_eq!(return_to_a.state_after[1].state, UploadState::Open);
}

#[test]
fn d5_capacity_superseded_digest_never_replays_over_live_slot() {
    let (fixture, _) = load_fixture();
    let vector = begin_vector(&fixture, "B08_delayed_a_none_refuses_live_b");
    assert_eq!(
        vector.initial_records,
        begin_vector(&fixture, "B04_different_digest_supersedes_open").state_after
    );
    assert_eq!(vector.state_after, vector.initial_records);

    let superseded = vector
        .initial_records
        .iter()
        .find(|record| record.state == UploadState::Superseded)
        .expect("delayed begin must retain superseded A");
    let live = vector
        .initial_records
        .iter()
        .find(|record| matches!(record.state, UploadState::Open | UploadState::Finished))
        .expect("delayed begin must retain live B");
    let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
    let (_, _, _, _, _, digest, expected_open) = request_begin(request.clone());
    assert_eq!(digest, superseded.digest);
    assert_ne!(digest, live.digest);
    assert_eq!(expected_open, None);

    let expected = response_begin(parse_exact::<LineageResponse>(
        &vector.expected_bytes_base64,
        &vector.id,
    ));
    assert_eq!(evaluate_begin(&fixture, vector, &request), expected);
    assert_eq!(
        expected,
        BeginResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::UploadConflict,
                receipt_id: None,
                details: RefusalDetails::Live {
                    upload_id: live.upload_id.clone(),
                    digest: live.digest.clone(),
                },
            },
        }
    );
}

#[test]
fn d5_capacity_consumed_digest_cannot_bypass_live_slot() {
    let (fixture, _) = load_fixture();
    for id in [
        "B12_consumed_a_none_refuses_live_b",
        "B10_b_none_refuses_live_a",
    ] {
        let vector = begin_vector(&fixture, id);
        assert_eq!(vector.initial_records.len(), 2, "{id}");
        let consumed = vector
            .initial_records
            .iter()
            .find(|record| record.state == UploadState::Consumed)
            .expect("consumed-digest conflict must retain its consumed row");
        let live = vector
            .initial_records
            .iter()
            .find(|record| matches!(record.state, UploadState::Open | UploadState::Finished))
            .expect("consumed-digest conflict must retain its live row");
        let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
        let (_, _, _, _, _, digest, expected_open) = request_begin(request.clone());
        assert_eq!(digest, consumed.digest, "{id}");
        assert_ne!(digest, live.digest, "{id}");
        assert_eq!(expected_open, None, "{id}");
        let expected = response_begin(parse_exact::<LineageResponse>(
            &vector.expected_bytes_base64,
            &vector.id,
        ));
        assert_eq!(evaluate_begin(&fixture, vector, &request), expected, "{id}");
        assert_eq!(vector.state_after, vector.initial_records, "{id}");
    }

    let vector = begin_vector(&fixture, "B13_consumed_a_expected_b_supersedes");
    let consumed = vector
        .initial_records
        .iter()
        .find(|record| record.state == UploadState::Consumed)
        .expect("consumed-digest supersession must retain consumed A");
    let live = vector
        .initial_records
        .iter()
        .find(|record| matches!(record.state, UploadState::Open | UploadState::Finished))
        .expect("consumed-digest supersession must retain live B");
    let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
    let (_, _, _, _, _, digest, expected_open) = request_begin(request.clone());
    assert_eq!(digest, consumed.digest);
    assert_eq!(expected_open.as_deref(), Some(live.upload_id.as_str()));
    let expected = response_begin(parse_exact::<LineageResponse>(
        &vector.expected_bytes_base64,
        &vector.id,
    ));
    assert_eq!(evaluate_begin(&fixture, vector, &request), expected);

    let replacement = vector
        .state_after
        .iter()
        .find(|record| record.state == UploadState::Open)
        .expect("consumed-digest supersession must allocate new A");
    assert_eq!(replacement.digest, consumed.digest);
    assert_ne!(replacement.upload_id, consumed.upload_id);
    assert!(vector.state_after.iter().any(|record| {
        record.upload_id == live.upload_id && record.state == UploadState::Superseded
    }));
    assert!(vector.state_after.contains(consumed));
}

#[test]
fn d5_capacity_check_upload_refs_require_finished_digest_binding() {
    let (fixture, _) = load_fixture();
    for record in &fixture.upload_records {
        assert!(!record.predecessor_key.is_empty());
        assert!(!record.agent.is_empty());
        assert!(record.incarnation > 0);
        assert!(record.total_chunks > 0);
        assert!(valid_digest(&record.upload_ref.digest));
        assert!(record.upload_ref.total_bytes > 0);
    }

    for vector in &fixture.capacity_check_vectors {
        let (request, result) = parsed_check(vector);
        match (checked_body_binding(&fixture, &request), result) {
            (Ok((digest, bytes)), CapacityResult::Checked { estimate }) => {
                assert_eq!(estimate.body_sha256, digest, "{}", vector.id);
                assert_eq!(estimate.body_bytes, bytes, "{}", vector.id);
            }
            (Err(actual), CapacityResult::Refused { refusal }) => {
                assert_eq!(actual, refusal, "{}", vector.id);
                assert_eq!(refusal.receipt_id, None, "{}", vector.id);
            }
            (Ok(_), CapacityResult::Refused { .. }) => {
                panic!("{} refused an admissible body", vector.id)
            }
            (Err(error), CapacityResult::Checked { .. }) => {
                panic!("{} checked an inadmissible body: {error:?}", vector.id)
            }
        }
    }

    let byte_cap = check_vector(&fixture, "C12_inline_byte_cap");
    let (request, result) = parsed_check(byte_cap);
    let (_, _, _, CapacityBody::Inline { bytes }, _, _) = request_check(request) else {
        panic!("byte-cap vector must use inline body")
    };
    assert_eq!(
        wire_bytes(&bytes).len() as u64,
        fixture.constants.inline_body_limit_bytes + 1
    );
    assert!(matches!(
        result,
        CapacityResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::ByteCap,
                receipt_id: None,
                details: RefusalDetails::Cap { .. },
            }
        }
    ));

    for id in [
        "C13_unfinished_upload_ref",
        "C14_unknown_upload_ref",
        "C15_wrong_predecessor_upload_ref",
        "C16_wrong_agent_upload_ref",
        "C17_wrong_incarnation_upload_ref",
    ] {
        let vector = check_vector(&fixture, id);
        let (_, result) = parsed_check(vector);
        let CapacityResult::Refused { refusal } = result else {
            panic!("{id} must refuse")
        };
        assert_eq!(vector.refusal_body_bytes_read, Some(0));
        assert_eq!(refusal.reason, RefusalReason::InvalidArguments);
        assert_eq!(refusal.receipt_id, None);
        assert!(matches!(
            refusal.details,
            RefusalDetails::Field { ref field, .. } if field == "ref"
        ));
    }
}

#[test]
fn d5_capacity_arithmetic_matches_clause_17() {
    let (fixture, _) = load_fixture();
    let mut accounting_arms = BTreeSet::new();
    for arithmetic in &fixture.arithmetic_vectors {
        let vector = check_vector(&fixture, &arithmetic.check_vector_id);
        assert_eq!(
            vector.arithmetic_vector_id.as_deref(),
            Some(arithmetic.id.as_str())
        );
        let estimate = checked_estimate(vector);
        accounting_arms.insert(estimate.reserve_accounting);
        assert_eq!(
            estimate.soft_bounded,
            estimate
                .geometry_wire
                .usable_soft
                .min(estimate.geometry_wire.usable_hard),
            "{} soft_bounded",
            arithmetic.id
        );
        if let Some(reserve) = reserve_tokens(&estimate.reserve) {
            let fit_soft = match estimate.reserve_accounting {
                ReserveAccounting::OnceCarved => estimate.soft_bounded,
                ReserveAccounting::NoneDeclared => estimate
                    .soft_bounded
                    .checked_sub(reserve)
                    .expect("R must not exceed soft_bounded"),
            };
            let hard_required = estimate
                .x
                .checked_add(reserve)
                .expect("X + R must not wrap");
            assert_eq!(
                arithmetic.expected_fit_soft,
                Some(fit_soft),
                "{}",
                arithmetic.id
            );
            assert_eq!(
                arithmetic.expected_hard_required,
                Some(hard_required),
                "{}",
                arithmetic.id
            );
        } else {
            assert_eq!(arithmetic.expected_fit_soft, None, "{}", arithmetic.id);
            assert_eq!(arithmetic.expected_hard_required, None, "{}", arithmetic.id);
        }
        assert_eq!(
            estimate.fit,
            evaluate_fit(vector, &estimate),
            "{}",
            arithmetic.id
        );
    }
    assert_eq!(
        accounting_arms,
        BTreeSet::from([
            ReserveAccounting::OnceCarved,
            ReserveAccounting::NoneDeclared,
        ])
    );
}

#[test]
fn d5_capacity_boundary_vectors_pin_soft_and_hard_cutoffs() {
    let (fixture, _) = load_fixture();
    for (fits_id, overflow_id) in [
        (
            "C02_once_soft_boundary_fits",
            "C03_once_soft_boundary_plus_one_overflows",
        ),
        (
            "C04_none_soft_boundary_fits",
            "C05_none_soft_boundary_plus_one_overflows",
        ),
        (
            "C06_hard_boundary_fits",
            "C07_hard_boundary_plus_one_overflows",
        ),
    ] {
        let fits = checked_estimate(check_vector(&fixture, fits_id));
        let overflow = checked_estimate(check_vector(&fixture, overflow_id));
        assert_eq!(fits.fit, CapacityFit::Fits, "{fits_id}");
        assert!(
            matches!(overflow.fit, CapacityFit::Overflow { .. }),
            "{overflow_id}"
        );
        assert_eq!(overflow.x, fits.x + 1, "boundary pair X delta");
        let reserve = reserve_tokens(&fits.reserve).expect("boundary reserve");
        if fits_id == "C06_hard_boundary_fits" {
            assert_eq!(fits.x + reserve, fits.geometry_wire.usable_hard);
            assert_eq!(overflow.x + reserve, overflow.geometry_wire.usable_hard + 1);
        } else {
            let fit_soft = match fits.reserve_accounting {
                ReserveAccounting::OnceCarved => fits.soft_bounded,
                ReserveAccounting::NoneDeclared => fits.soft_bounded - reserve,
            };
            assert_eq!(fits.x, fit_soft);
            assert_eq!(overflow.x, fit_soft + 1);
        }
    }
}

#[test]
fn d5_capacity_unknown_never_becomes_overflow() {
    let (fixture, _) = load_fixture();
    let expected = BTreeSet::from([
        CapacityUnknownReason::ReserveUnknown,
        CapacityUnknownReason::EstimatorUnavailable,
        CapacityUnknownReason::GeometryMismatch,
    ]);
    let actual = [
        "C08_reserve_unknown",
        "C09_estimator_unavailable",
        "C10_geometry_mismatch",
    ]
    .into_iter()
    .map(|id| {
        let estimate = checked_estimate(check_vector(&fixture, id));
        let CapacityFit::Unknown { reason } = estimate.fit else {
            panic!("{id} must remain unknown, never overflow")
        };
        reason
    })
    .collect::<BTreeSet<_>>();
    assert_eq!(actual, expected);

    let reserve_unknown = checked_estimate(check_vector(&fixture, "C08_reserve_unknown"));
    assert!(reserve_unknown.x > reserve_unknown.soft_bounded);
    assert!(matches!(
        reserve_unknown.reserve,
        KnownReserve::Unknown { .. }
    ));
    assert_eq!(
        reserve_unknown.fit,
        CapacityFit::Unknown {
            reason: CapacityUnknownReason::ReserveUnknown,
        }
    );
}

#[test]
fn d5_capacity_gateway_binding_vectors_preserve_custody() {
    let (fixture, _) = load_fixture();
    assert_eq!(
        fixture
            .gateway_binding_vectors
            .iter()
            .map(|vector| vector.id.as_str())
            .collect::<Vec<_>>(),
        [
            "G01_digest_match_sends",
            "G02_digest_mismatch_checks_again",
            "G03_unknown_preserves",
            "G04_overflow_preserves",
        ]
    );
    for vector in &fixture.gateway_binding_vectors {
        assert!(valid_digest(&vector.candidate_body_sha256));
        let estimate = checked_estimate(check_vector(&fixture, &vector.check_vector_id));
        assert_eq!(
            gateway_outcome(&estimate, &vector.candidate_body_sha256),
            vector.expected,
            "{}",
            vector.id
        );
        assert!(vector.expected.custody_preserved);
    }
}

#[test]
fn d5_capacity_check_replay_key_is_complete() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.capacity_check_key_vectors.len(), 6);
    for vector in &fixture.capacity_check_key_vectors {
        let base_vector = check_vector(&fixture, &vector.base_check_vector_id);
        let comparison_vector = check_vector(&fixture, &vector.comparison_check_vector_id);
        let (base_request, base_result) = parsed_check(base_vector);
        let CapacityResult::Checked { estimate: base } = base_result else {
            panic!("{} base must be CHECKED", vector.id)
        };
        let (comparison_request, comparison_result) = parsed_check(comparison_vector);
        assert_eq!(
            body_sha256(&request_check(base_request.clone()).3)
                == body_sha256(&request_check(comparison_request.clone()).3),
            vector.same_body_sha256,
            "{} body identity",
            vector.id
        );
        match (vector.expected, comparison_result) {
            (CheckKeyExpected::ByteIdenticalReplay, CapacityResult::Checked { estimate }) => {
                assert_eq!(
                    canonical_check_key(&base_request, &base),
                    canonical_check_key(&comparison_request, &estimate)
                );
                assert_eq!(
                    base_vector.expected_bytes_base64,
                    comparison_vector.expected_bytes_base64
                );
                assert!(vector.same_complete_check_key);
            }
            (CheckKeyExpected::NewEstimate, CapacityResult::Checked { estimate }) => {
                assert_ne!(
                    canonical_check_key(&base_request, &base),
                    canonical_check_key(&comparison_request, &estimate)
                );
                assert_ne!(
                    base_vector.expected_bytes_base64,
                    comparison_vector.expected_bytes_base64
                );
                assert!(!vector.same_complete_check_key);
            }
            (CheckKeyExpected::InvalidArgumentsModel, CapacityResult::Refused { refusal }) => {
                assert_eq!(refusal.reason, RefusalReason::InvalidArguments);
                assert_eq!(refusal.receipt_id, None);
                assert!(matches!(
                    refusal.details,
                    RefusalDetails::Field { ref field, .. } if field == "model"
                ));
                assert!(!vector.same_complete_check_key);
            }
            (CheckKeyExpected::CheckedWithArgumentModel, CapacityResult::Checked { estimate }) => {
                let (_, _, _, CapacityBody::Upload { upload_ref }, model, _) =
                    request_check(comparison_request)
                else {
                    panic!("argument-authoritative vector must use upload ref")
                };
                let record = fixture
                    .upload_records
                    .iter()
                    .find(|record| record.upload_ref == upload_ref)
                    .expect("argument-authoritative upload record");
                assert_eq!(record.declared_model, None);
                assert_eq!(estimate.model, model);
                assert!(!vector.same_complete_check_key);
            }
            _ => panic!("{} check-key expectation mismatch", vector.id),
        }
    }
}

#[test]
fn d5_capacity_consumed_upload_replays_checked_result() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.capacity_lifecycle_vectors.len(), 1);
    let vector = &fixture.capacity_lifecycle_vectors[0];
    assert_eq!(vector.id, "L01_lost_checked_reply_replays_consumed_upload");
    assert!(!vector.name.is_empty());
    assert_eq!(vector.initial_record.state, UploadState::Consumed);
    assert_eq!(vector.original_body_bytes_base64, None);
    assert_eq!(vector.retained_staged_bytes, 0);
    assert_eq!(vector.checked_result_cache_entries, 1);
    assert_eq!(
        vector.checked_result_cache_limit,
        fixture.constants.max_checked_results_per_scope
    );
    assert!(vector.matching_complete_check_key);
    assert_eq!(vector.expected_source, "checked_result_cache");
    assert!(!vector.re_tokenized);
    assert_eq!(
        vector.replay_key,
        [
            "P",
            "agent",
            "incarnation",
            "body_sha256",
            "model",
            "geometry_wire",
            "reserve_accounting",
            "estimator.identity",
            "estimator.version",
        ]
    );

    let first_request = parse_exact::<LineageRequest>(
        &vector.first_request_bytes_base64,
        "first consumed-upload check",
    );
    let replay_request = parse_exact::<LineageRequest>(
        &vector.replay_request_bytes_base64,
        "replayed consumed-upload check",
    );
    assert_eq!(first_request, replay_request);
    let (_, _, _, body, _, _) = request_check(replay_request);
    let CapacityBody::Upload { upload_ref } = body else {
        panic!("consumed replay must cite UploadRef")
    };
    assert_eq!(upload_ref, vector.initial_record.upload_ref);

    let first =
        parse_exact::<LineageResponse>(&vector.first_checked_bytes_base64, "first CHECKED result");
    let replay = parse_exact::<LineageResponse>(
        &vector.replay_checked_bytes_base64,
        "replayed CHECKED result",
    );
    assert_eq!(
        first, replay,
        "lost reply must replay byte-identical CHECKED data"
    );
    let first_estimator = match response_check(first) {
        CapacityResult::Checked { estimate } => estimate.estimator,
        CapacityResult::Refused { .. } => panic!("first result must be CHECKED"),
    };
    let replay_estimator = match response_check(replay) {
        CapacityResult::Checked { estimate } => estimate.estimator,
        CapacityResult::Refused { .. } => panic!("replay result must be CHECKED"),
    };
    assert_eq!(first_estimator, replay_estimator);
    assert_eq!(first_estimator.identity, "mc-tokenizer");
    assert_eq!(first_estimator.version, "711b097e");
    assert_eq!(
        vector.first_checked_bytes_base64,
        vector.replay_checked_bytes_base64
    );
}

#[test]
fn d5_capacity_changed_check_key_requires_reupload_after_consumption() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.capacity_reupload_vectors.len(), 3);
    for vector in &fixture.capacity_reupload_vectors {
        assert!(!vector.id.is_empty());
        assert!(matches!(
            vector.changed_check_input.as_str(),
            "geometry_wire.usable_hard" | "reserve_accounting" | "estimator.version"
        ));
        assert!(vector.reupload_required);
        assert_eq!(vector.original_body_bytes_base64, None);
        assert_eq!(vector.retained_staged_bytes_before_reupload, 0);
        assert_eq!(vector.consumed_ref.digest, vector.replacement_ref.digest);
        assert_ne!(
            vector.consumed_ref.upload_id,
            vector.replacement_ref.upload_id
        );
        assert_eq!(vector.replacement_state_before_check, UploadState::Finished);
        assert_eq!(vector.replacement_state_after_check, UploadState::Consumed);

        let consumed_request = parse_exact::<LineageRequest>(
            &vector.consumed_check_request_bytes_base64,
            &format!("{} consumed request", vector.id),
        );
        let (_, _, _, CapacityBody::Upload { upload_ref }, _, _) = request_check(consumed_request)
        else {
            panic!("{} must cite the consumed ref", vector.id)
        };
        assert_eq!(upload_ref, vector.consumed_ref);
        let consumed_result = response_check(parse_exact::<LineageResponse>(
            &vector.expected_consumed_check_bytes_base64,
            &format!("{} consumed result", vector.id),
        ));
        assert_eq!(
            consumed_result,
            CapacityResult::Refused {
                refusal: field_refusal("ref", "re_upload_required"),
            }
        );

        let replacement = checked_estimate(check_vector(&fixture, &vector.check_vector_id));
        assert_eq!(replacement.body_sha256, vector.replacement_ref.digest);
        assert_eq!(replacement.body_bytes, vector.replacement_ref.total_bytes);
    }

    let base = checked_estimate(check_vector(&fixture, "C02_once_soft_boundary_fits"));
    let changed = checked_estimate(check_vector(
        &fixture,
        "C22_same_digest_changed_estimator_reestimates",
    ));
    assert_eq!(base.body_sha256, changed.body_sha256);
    assert_ne!(base.estimator.version, changed.estimator.version);
}

#[test]
fn d5_capacity_checked_result_cache_evicts_lru_ninth_key() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.checked_result_eviction_vectors.len(), 1);
    let vector = &fixture.checked_result_eviction_vectors[0];
    assert_eq!(vector.id, "EVICT01_ninth_check_evicts_oldest");
    assert_eq!(
        vector.capacity,
        fixture.constants.max_checked_results_per_scope
    );
    assert_eq!(vector.policy, fixture.constants.checked_result_eviction);
    assert_eq!(vector.initial_entries.len() as u64, vector.capacity);
    assert_eq!(vector.entries_after.len() as u64, vector.capacity);
    assert_eq!(
        vector.evicted_check_key_sha256,
        vector.initial_entries[0].check_key_sha256
    );
    assert!(!vector
        .entries_after
        .iter()
        .any(|entry| entry.check_key_sha256 == vector.evicted_check_key_sha256));
    assert_eq!(vector.entries_after.last(), Some(&vector.ninth_entry));
    assert!(vector
        .initial_entries
        .windows(2)
        .all(|pair| pair[0].checked_at_order < pair[1].checked_at_order));
    assert!(vector.evicted_replay_requires_fresh_upload);
    assert_eq!(vector.original_body_bytes_base64, None);
    assert_eq!(vector.retained_staged_bytes, 0);
    assert!(valid_digest(&vector.evicted_check_key_sha256));
}

#[test]
fn d5_capacity_different_digest_supersedes_without_wedging_scope() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.capacity_supersession_vectors.len(), 1);
    let vector = &fixture.capacity_supersession_vectors[0];
    assert_eq!(
        vector.id,
        "SUPERSEDE01_different_digest_replaces_live_upload"
    );
    assert_eq!(
        vector.begin_vector_id,
        "B04_different_digest_supersedes_open"
    );
    assert_eq!(
        vector.state_after_begin,
        begin_vector(&fixture, &vector.begin_vector_id).state_after
    );
    assert_eq!(vector.state_after_begin.len(), 2);
    assert_eq!(vector.state_before_check.len(), 2);
    assert_eq!(vector.state_after_check.len(), 2);

    let older_after = vector
        .state_after_begin
        .iter()
        .find(|record| record.state == UploadState::Superseded)
        .expect("state after begin must retain the superseded upload");
    let newer_after_begin = vector
        .state_after_begin
        .iter()
        .find(|record| record.state == UploadState::Open)
        .expect("state after begin must include the replacement upload");
    let older_before_check = vector
        .state_before_check
        .iter()
        .find(|record| record.upload_id == older_after.upload_id)
        .expect("state before check must retain the superseded upload");
    let newer_before_check = vector
        .state_before_check
        .iter()
        .find(|record| record.upload_id == newer_after_begin.upload_id)
        .expect("state before check must retain the replacement upload");
    let older_after_check = vector
        .state_after_check
        .iter()
        .find(|record| record.upload_id == older_after.upload_id)
        .expect("state after check must retain the superseded upload");
    let newer_after_check = vector
        .state_after_check
        .iter()
        .find(|record| record.upload_id == newer_after_begin.upload_id)
        .expect("state after check must retain the consumed upload");

    assert_eq!(older_after.state, UploadState::Superseded);
    assert_eq!(older_before_check, older_after);
    assert_eq!(older_after_check, older_after);
    assert_eq!(newer_before_check.state, UploadState::Finished);
    assert_eq!(newer_after_check.state, UploadState::Consumed);
    assert_eq!(vector.older_body_bytes_base64, None);
    assert_eq!(vector.newer_body_bytes_base64, None);
    assert_ne!(older_after.digest, newer_before_check.digest);
    assert_eq!(newer_before_check.digest, newer_after_check.digest);
    assert_eq!(newer_before_check.upload_id, newer_after_check.upload_id);

    let operations = vector
        .late_operations
        .iter()
        .map(|operation| operation.operation.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        operations,
        BTreeSet::from(["capacity.put", "capacity.finish", "capacity.check"])
    );
    for operation in &vector.late_operations {
        assert_eq!(operation.upload_id, older_after.upload_id);
        assert_eq!(operation.expected_refusal.receipt_id, None);
        assert_eq!(
            operation.expected_refusal.reason,
            RefusalReason::InvalidArguments
        );
        assert_eq!(
            operation.expected_refusal.details,
            RefusalDetails::Field {
                field: "upload_id".to_owned(),
                reason: "superseded".to_owned(),
            }
        );
        assert!(operation.newer_upload_unchanged);
        assert_eq!(operation.bytes_read, 0);
        match operation.operation.as_str() {
            "capacity.put" | "capacity.finish" => {
                let request = parse_exact::<LineageRequest>(
                    operation
                        .request_bytes_base64
                        .as_deref()
                        .expect("late capacity upload request bytes"),
                    &operation.operation,
                );
                let (op, upload_id) = upload_operation(request);
                let expected_op = if operation.operation == "capacity.put" {
                    UploadOperation::CapacityPut
                } else {
                    UploadOperation::CapacityFinish
                };
                assert_eq!(op, expected_op);
                assert_eq!(upload_id, operation.upload_id);
                let refusal = refused_upload_response(parse_exact::<LineageResponse>(
                    operation
                        .expected_bytes_base64
                        .as_deref()
                        .expect("late capacity upload response bytes"),
                    &operation.operation,
                ));
                assert_eq!(refusal, operation.expected_refusal);
            }
            "capacity.check" => {
                assert_eq!(operation.request_bytes_base64, None);
                assert_eq!(operation.expected_bytes_base64, None);
            }
            other => panic!("unexpected late operation {other}"),
        }
    }
    let newer = checked_estimate(check_vector(&fixture, &vector.newer_check_vector_id));
    assert_eq!(newer.body_sha256, newer_before_check.digest);
}

#[test]
fn d5_capacity_upload_limits_are_explicit_per_scope() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.constants.max_open_uploads_per_scope, 1);
    assert_eq!(fixture.constants.max_bytes_per_upload, 64 * 1_048_576);
    assert_eq!(fixture.constants.max_chunk_bytes, 1_048_576);
    assert!(fixture.constants.accepted_seq_counts_once);
    assert_eq!(fixture.constants.upload_accounting_scope, "scope");
    assert_eq!(fixture.constants.max_checked_results_per_scope, 8);
    assert_eq!(
        fixture.constants.checked_result_eviction,
        "lru_by_check_time"
    );
    assert_eq!(
        fixture.constants.max_retained_staged_bytes_per_scope,
        fixture.constants.max_bytes_per_upload
    );
    assert!(fixture.constants.consumption_frees_staged_bytes);

    let vector = begin_vector(&fixture, "B07_max_bytes_refuses");
    let request = parse_exact::<LineageRequest>(&vector.request_bytes_base64, &vector.id);
    let (_, _, _, total_bytes, _, _, _) = request_begin(request);
    assert_eq!(total_bytes, fixture.constants.max_bytes_per_upload + 1);
    let result = response_begin(parse_exact::<LineageResponse>(
        &vector.expected_bytes_base64,
        &vector.id,
    ));
    assert_eq!(
        result,
        BeginResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::ByteCap,
                receipt_id: None,
                details: RefusalDetails::Cap {
                    cap: "capacity_upload".to_owned(),
                    actual: fixture.constants.max_bytes_per_upload + 1,
                    limit: fixture.constants.max_bytes_per_upload,
                    units: "bytes".to_owned(),
                },
            },
        }
    );
}

#[test]
fn d5_capacity_upload_authorization_keeps_ticket_domains_separate() {
    let (fixture, _) = load_fixture();
    assert_eq!(fixture.upload_authorization_vectors.len(), 8);
    for vector in &fixture.upload_authorization_vectors {
        let (op, upload_id) = upload_operation(parse_exact::<LineageRequest>(
            &vector.request_bytes_base64,
            &vector.id,
        ));
        assert_eq!(op, vector.op);
        let capacity_operation = matches!(
            vector.op,
            UploadOperation::CapacityPut | UploadOperation::CapacityFinish
        );
        assert_eq!(
            capacity_operation,
            vector.caller_kind == CallerKind::CapacityScope,
            "{} operation authority",
            vector.id
        );
        assert_eq!(
            upload_id.contains("capacity-upload"),
            vector.upload_kind == UploadKind::Capacity,
            "{} upload identity",
            vector.id
        );
        let authorized = capacity_operation == (vector.upload_kind == UploadKind::Capacity);
        assert_eq!(
            vector.ticket_present,
            vector.caller_kind == CallerKind::LineageTicketBound,
            "{} ticket shape",
            vector.id
        );
        match (&vector.expected, authorized) {
            (UploadAuthorizationExpected::Authorized { refusal }, true) => {
                assert_eq!(refusal, &None, "{}", vector.id);
            }
            (UploadAuthorizationExpected::Refused { refusal }, false) => {
                assert_eq!(refusal.reason, RefusalReason::InvalidArguments);
                assert_eq!(refusal.receipt_id, None);
                assert!(matches!(
                    refusal.details,
                    RefusalDetails::Field { ref field, .. } if field == "upload_id"
                ));
            }
            _ => panic!(
                "{} crosses capacity and lineage upload authority",
                vector.id
            ),
        }
    }
}

#[test]
fn d5_capacity_fixture_has_no_unsettled_24a_ambiguities() {
    let (fixture, _) = load_fixture();
    assert!(fixture.unsettled_24a_ambiguities.is_empty());
}

#[test]
fn d5_capacity_fixture_is_indexed() {
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
        .expect("capacity fixture is indexed");
    assert_eq!(entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(entry["derived"], false);
    assert_eq!(entry["source"], INDEX_SOURCE);
    assert_eq!(
        entry["generation_script"],
        "packages/plugin/scripts/gen-d5-specimen-fixture.py"
    );
}

#[test]
fn d5_capacity_begin_expected_open_follows_option_convention() {
    let (fixture, _) = load_fixture();
    for vector in &fixture.capacity_begin_vectors {
        let bytes = wire_bytes(&vector.request_bytes_base64);
        let text = std::str::from_utf8(&bytes).expect("utf8 request");
        assert!(
            !text.contains("\"expected_open\":null"),
            "{} encodes an absent expected_open as null",
            vector.id
        );
    }
    let with_null = br#"{"op":"capacity.begin","P":"p","agent":"parent","incarnation":1,"total_bytes":1,"total_chunks":1,"digest":"00","expected_open":null}"#;
    assert!(serde_json::from_slice::<LineageRequest>(with_null).is_err());
    let omitted = br#"{"op":"capacity.begin","P":"p","agent":"parent","incarnation":1,"total_bytes":1,"total_chunks":1,"digest":"00"}"#;
    let parsed = serde_json::from_slice::<LineageRequest>(omitted).expect("omitted parses");
    assert_eq!(
        serde_json::to_vec(&parsed).expect("serialize"),
        omitted.to_vec()
    );
}
