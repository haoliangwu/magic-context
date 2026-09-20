use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "support/d5_scope_model.rs"]
mod d5_scope_model;

use d5_scope_model::{
    decode_keyed_response, CapacityCheckOutcome, ModelRequest, ModelSeed, PrepareOutcome,
    ScopeFacts, ScopeModel, StepOutcome,
};

const RECEIPT_ID: &str = "0f5c2d7e-1234-4abc-8def-0123456789ab";
const SEALED_TOKEN: &str = "aaisem2ekvthpcezvk5q";
const LEGACY_EXPECTED_SHA256: [&str; 20] = [
    "d09df1194fe7bce6c043505309ecad441f921d6f3b642e7ee100f836c78f83e9",
    "d09df1194fe7bce6c043505309ecad441f921d6f3b642e7ee100f836c78f83e9",
    "5997921873a9d247cafaa95cce44ab186716e2132de1641160e65123d86b4eef",
    "69e2e3be0715f83fdc7f358eeb598cd3849015494113637522247c014313a5a9",
    "69e2e3be0715f83fdc7f358eeb598cd3849015494113637522247c014313a5a9",
    "69e2e3be0715f83fdc7f358eeb598cd3849015494113637522247c014313a5a9",
    "69e2e3be0715f83fdc7f358eeb598cd3849015494113637522247c014313a5a9",
    "69e2e3be0715f83fdc7f358eeb598cd3849015494113637522247c014313a5a9",
    "ea487b4c91d201e5960fe7eb0b62c5dd0576929a9c0b73787474c3c7d5a76bd3",
    "805d84a372d588759c80efdd7b0d4858ab7967eb5ae805579f83037b5b062827",
    "7ffa1f372fad507823f71b375f44e62961522c48b758972acacb5b689e287925",
    "e29876e2785f4df42a4bfd8bd95af109b31cd0592f16113fb03e56ddcb35222b",
    "a3b6f20dd63d3b618ca1f61b12b1a9f8e08b7720e188fd9f532b6b83ac03f31f",
    "32d5c8a52b29bf7222ff55d299185c23f3e3332ccf644d12c6a113860dc06cdc",
    "0c83490e5bed78730d193c2cd08d28e092e983d31922f606374a62e020536b91",
    "9578fdbb117edc2a1b72ee88d48632f755fd5c6d70ccb5b584a808fa1445a345",
    "12267f99bd3f662c2afbe866a77be3abd7d48265f3a42d76ca9759ef18781eb7",
    "12267f99bd3f662c2afbe866a77be3abd7d48265f3a42d76ca9759ef18781eb7",
    "12267f99bd3f662c2afbe866a77be3abd7d48265f3a42d76ca9759ef18781eb7",
    "53aa3fd1bb304df20f5b45e467e63c2dda8fae42144563ff4d942f8d3cca0f27",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    encoding_rule: EncodingRule,
    serde_evidence: Vec<SerdeEvidence>,
    sealed_scope: SealedScope,
    token_values: Vec<TokenValue>,
    legacy_expected_bytes: Vec<LegacyExpectedBytes>,
    precondition_space: PreconditionSpace,
    precedence_table: Vec<PrecedenceRow>,
    vectors: Vec<Vector>,
    r47_model_seed: ModelSeed,
    r47_specimen_preimages: Vec<SpecimenPreimage>,
    r47_sequences: Vec<R47Sequence>,
    negative_vectors: Vec<NegativeVector>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    lineage_request: String,
    lineage_response: String,
    nested_unions: String,
    implementation_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SerdeEvidence {
    path: String,
    lines: String,
    finding: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedScope {
    receipt_id: String,
    recognition_token: String,
    stored_edge: LineageEdge,
    fence_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenValue {
    recognition_token: String,
    input_96_bits_hex: String,
    round_trip_matches_input: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreconditionSpace {
    evaluation_order: Vec<String>,
    dimensions: PreconditionDimensions,
    delivery_evidence_rule: String,
    metadata_rule: String,
    candidate_scope_rule: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreconditionDimensions {
    scope_state: Vec<String>,
    observation_class: Vec<String>,
    candidate_by_scope: BTreeMap<String, Vec<String>>,
    delivery_evidence: Vec<String>,
    metadata: Vec<String>,
    candidate_scope: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrecedenceRow {
    row_id: String,
    priority: u64,
    preconditions: Preconditions,
    applies_regardless_of: Vec<String>,
    expected_variant: String,
    expected_reason_or_cause: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preconditions {
    scope_state: Vec<String>,
    observation_class: Vec<String>,
    candidate: Vec<String>,
    delivery_evidence: Vec<String>,
    metadata: Vec<String>,
    candidate_scope: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    scope_state: ScopeState,
    scanned_material: ScannedMaterial,
    request: Value,
    expected: Value,
    precedence_row: String,
    #[serde(default)]
    candidate_scope: CandidateScopeFacts,
    request_bytes_base64: Option<String>,
    expected_bytes_base64: Option<String>,
    transition: Option<CandidateScopeTransition>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScannedMaterial {
    source_text: Option<String>,
    scanned_bytes_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyExpectedBytes {
    vector_id: String,
    bytes_base64: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CandidateScopeFacts {
    row: CandidateScopeRow,
    lineage_relation: Option<LineageRelation>,
    source_uploads_live: u64,
    attempts_prepared_or_later: u64,
    in_edges: u64,
    out_edges: u64,
}

impl Default for CandidateScopeFacts {
    fn default() -> Self {
        Self {
            row: CandidateScopeRow::Absent,
            lineage_relation: None,
            source_uploads_live: 0,
            attempts_prepared_or_later: 0,
            in_edges: 0,
            out_edges: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CandidateScopeRow {
    Absent,
    Present,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
enum LineageRelation {
    #[serde(rename = "L_P")]
    Predecessor,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateScopeTransition {
    lineage_id_before: Option<String>,
    lineage_id_after: Option<String>,
    incarnation_before: Option<u64>,
    incarnation_after: Option<u64>,
    resolve_generation_before: Option<u64>,
    resolve_generation_after: Option<u64>,
    placeholder_retired: Option<String>,
    predecessor_counter_before: u64,
    predecessor_counter_after: u64,
    positive_custody_before: u64,
    positive_custody_after: u64,
    capacity_uploads_before: u64,
    capacity_uploads_after: u64,
}

/// An authored digest whose preimage the fixture records, so a reader can
/// recompute it instead of taking a 64-character literal on trust.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecimenPreimage {
    value: String,
    preimage_utf8: String,
    #[serde(rename = "use")]
    usage: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct R47Sequence {
    id: String,
    name: String,
    note: String,
    steps: Vec<SequenceStep>,
}

/// One executed operation: the request the model is fed, the result bytes it
/// must produce, and the scope rows the store must show afterwards.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceStep {
    op: String,
    #[serde(default)]
    note: Option<String>,
    /// A redeem step runs the request of the vector it names, so a sequence and
    /// the precedence-table vectors in this same fixture cannot drift apart.
    #[serde(default)]
    vector_id: Option<String>,
    #[serde(default)]
    request_bytes_base64: Option<String>,
    #[serde(default)]
    result_bytes_base64: Option<String>,
    #[serde(default)]
    response_bytes_base64: Option<String>,
    #[serde(default)]
    bounded_outcome: Option<BoundedOutcome>,
    scopes_after: Vec<ScopeFacts>,
}

/// The two outcomes the reference model declines to invent a wire body for.
/// Each names what is missing and which fixture owns it.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BoundedOutcome {
    PrepareAdmitted {
        attempt_id: String,
        unmodelled_wire_result: String,
    },
    CapacityCheckAuthorized {
        upload_id: String,
        unmodelled_wire_result: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NegativeVector {
    id: String,
    name: String,
    response_bytes_base64: String,
    rejected_field: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum ScopeState {
    #[serde(rename = "SEALED")]
    Sealed,
    #[serde(rename = "REDEEMED")]
    Redeemed,
    #[serde(rename = "absent")]
    Absent,
}

impl ScopeState {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Sealed => "SEALED",
            Self::Redeemed => "REDEEMED",
            Self::Absent => "absent",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum LineageRequest {
    Redeem {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        observation: RecognitionObservation,
        candidate: Option<SuccessorCandidate>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
enum LineageResponse {
    Redeem { result: RedeemResult },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RecognitionObservation {
    scanned_identity: Option<BlockIdentity>,
    scanned_bytes_sha256: Option<String>,
    scanned_role: Option<Role>,
    scanned_kind: Option<BlockKind>,
    native_user_index: Option<u64>,
    scan_source: ScanSource,
    observed_markers: Vec<ObservedMarker>,
    may_have_replied: bool,
    ack: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Role {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BlockKind {
    Text,
    Reasoning,
    RedactedReasoning,
    ToolUse,
    ToolResult,
    Image,
    Document,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ScanSource {
    DirectScalar,
    TextBlock,
    ToolResult,
    NoCandidateBlock,
    Other { source: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ObservedMarker {
    Valid { identity: RecognitionIdentity },
    Malformed { token_prefix: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecognitionIdentity {
    receipt_id: String,
    recognition_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SuccessorCandidate {
    successor_key: String,
    native_continuation_identity: BlockIdentity,
    continuation_identity: RecognitionIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BlockIdentity {
    mid: String,
    index: u64,
    ordinal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum RedeemResult {
    #[serde(rename = "REDEEMED")]
    Redeemed {
        receipt_id: String,
        edge: Box<LineageEdge>,
        existing: bool,
        fence_generation: u64,
        #[serde(default, deserialize_with = "deserialize_present_lineage_id")]
        lineage_adopted_from: Option<String>,
    },
    #[serde(rename = "UNRECOGNIZED")]
    Unrecognized {
        receipt_id: String,
        cause: UnrecognizedCause,
    },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
    #[serde(rename = "lineage_corrupt")]
    LineageCorrupt { receipt_id: String },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UnrecognizedCause {
    NoCandidateBlock,
    NoMarker,
    MalformedMarker,
    DuplicateMarker,
    ForeignMarker,
}

impl UnrecognizedCause {
    fn wire_name(self) -> &'static str {
        match self {
            Self::NoCandidateBlock => "no_candidate_block",
            Self::NoMarker => "no_marker",
            Self::MalformedMarker => "malformed_marker",
            Self::DuplicateMarker => "duplicate_marker",
            Self::ForeignMarker => "foreign_marker",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Refusal {
    reason: RefusalReason,
    receipt_id: Option<String>,
    details: RefusalDetails,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalReason {
    InvalidArguments,
    TicketInvalid,
    StaleIncarnation,
    BudgetUnknown,
    BudgetModelMismatch,
    BudgetEvidenceMismatch,
    TokenCap,
    ByteCap,
    PAlreadySealed,
    SealMaterialMismatch,
    ResolvedAbsent,
    SealAfterTombstone,
    SealAfterResolve,
    AttemptQuota,
    SealedUnredeemed,
    LineageCorrupt,
    SuccessorOverflow,
    AlreadyRedeemed,
    InvalidTerminalState,
    UploadDeclarationConflict,
    ChunkConflict,
    UploadDigestMismatch,
    UploadIncomplete,
    UploadQuota,
    D5ReceiptRequired,
    D5DowngradeRefused,
}

impl RefusalReason {
    fn wire_name(self) -> &'static str {
        match self {
            Self::InvalidArguments => "invalid_arguments",
            Self::TicketInvalid => "ticket_invalid",
            Self::StaleIncarnation => "stale_incarnation",
            Self::BudgetUnknown => "budget_unknown",
            Self::BudgetModelMismatch => "budget_model_mismatch",
            Self::BudgetEvidenceMismatch => "budget_evidence_mismatch",
            Self::TokenCap => "token_cap",
            Self::ByteCap => "byte_cap",
            Self::PAlreadySealed => "p_already_sealed",
            Self::SealMaterialMismatch => "seal_material_mismatch",
            Self::ResolvedAbsent => "resolved_absent",
            Self::SealAfterTombstone => "seal_after_tombstone",
            Self::SealAfterResolve => "seal_after_resolve",
            Self::AttemptQuota => "attempt_quota",
            Self::SealedUnredeemed => "sealed_unredeemed",
            Self::LineageCorrupt => "lineage_corrupt",
            Self::SuccessorOverflow => "successor_overflow",
            Self::AlreadyRedeemed => "already_redeemed",
            Self::InvalidTerminalState => "invalid_terminal_state",
            Self::UploadDeclarationConflict => "upload_declaration_conflict",
            Self::ChunkConflict => "chunk_conflict",
            Self::UploadDigestMismatch => "upload_digest_mismatch",
            Self::UploadIncomplete => "upload_incomplete",
            Self::UploadQuota => "upload_quota",
            Self::D5ReceiptRequired => "d5_receipt_required",
            Self::D5DowngradeRefused => "d5_downgrade_refused",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RefusalDetails {
    None,
    Field {
        field: String,
        reason: String,
    },
    Winner {
        receipt_id: String,
    },
    ResolvedAbsent {
        attempt_id: String,
        incarnation: u64,
    },
    Cap {
        cap: String,
        actual: u64,
        limit: u64,
        units: String,
    },
    Upload {
        upload_id: Option<String>,
        seq: Option<u64>,
        declared_digest: Option<String>,
        actual_digest: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LineageEdge {
    edge_id: String,
    predecessor_key: String,
    successor_key: String,
    agent: String,
    #[serde(rename = "F")]
    fingerprint: MaterialFingerprint,
    lineage_id: String,
    continuation_identity: RecognitionIdentity,
    native_continuation_identity: BlockIdentity,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MaterialFingerprint {
    digest: String,
    normalization_version: u64,
    excluded_additions: Vec<Value>,
}

#[derive(Debug, PartialEq, Eq)]
struct OutcomeSignature<'a> {
    variant: &'static str,
    reason_or_cause: Option<&'a str>,
}

fn deserialize_present_lineage_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

    assert_eq!(encoded.len() % 4, 0, "base64 length");
    let mut decoded = Vec::new();
    let (chunks, remainder) = encoded.as_bytes().as_chunks::<4>();
    assert!(remainder.is_empty(), "base64 remainder");
    for chunk in chunks {
        let a = sextet(chunk[0]).expect("base64 digit");
        let b = sextet(chunk[1]).expect("base64 digit");
        let c = (chunk[2] != b'=').then(|| sextet(chunk[2]).expect("base64 digit"));
        let d = (chunk[3] != b'=').then(|| sextet(chunk[3]).expect("base64 digit"));
        decoded.push((a << 2) | (b >> 4));
        if let Some(c) = c {
            decoded.push((b << 4) | (c >> 2));
            if let Some(d) = d {
                decoded.push((c << 6) | d);
            }
        }
    }
    decoded
}

fn hex_96(value: &str) -> Result<[u8; 12], String> {
    if value.len() != 24 {
        return Err("96-bit input must contain 24 hex characters".to_string());
    }
    let mut decoded = [0_u8; 12];
    for (index, output) in decoded.iter_mut().enumerate() {
        *output = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "96-bit input contains non-hex characters".to_string())?;
    }
    Ok(decoded)
}

fn encode_base32_96(input: &[u8; 12]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut output = String::with_capacity(20);
    for byte in input {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(ALPHABET[((accumulator >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
    output
}

fn decode_base32_96(token: &str) -> Result<[u8; 12], String> {
    if token.len() != 20 {
        return Err("recognition token must be 20 bytes".to_string());
    }
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut output = Vec::with_capacity(12);
    for byte in token.bytes() {
        let value = match byte {
            b'a'..=b'z' => byte - b'a',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return Err("recognition token is not lowercase RFC4648 base32".to_string()),
        };
        accumulator = (accumulator << 5) | u32::from(value);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    if bits != 4 || accumulator & ((1_u32 << bits) - 1) != 0 {
        return Err("recognition token has non-zero canonical padding bits".to_string());
    }
    output
        .try_into()
        .map_err(|_| "recognition token does not decode to 96 bits".to_string())
}

fn valid_uuid36(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn parse_marker(marker: &str) -> Result<RecognitionIdentity, String> {
    if marker.starts_with("mc-d5:") {
        return Err("marker is missing its required leading space".to_string());
    }
    if marker.len() != 64 {
        return Err("marker must be 64 bytes including its leading space".to_string());
    }
    let rest = marker
        .strip_prefix(" mc-d5:")
        .ok_or_else(|| "marker must begin with a leading space and mc-d5:".to_string())?;
    let (receipt_id, recognition_token) = rest
        .split_once(':')
        .ok_or_else(|| "marker must separate receipt and token".to_string())?;
    if !valid_uuid36(receipt_id) {
        return Err("marker receipt is not lowercase UUID36".to_string());
    }
    let decoded = decode_base32_96(recognition_token)?;
    if encode_base32_96(&decoded) != recognition_token {
        return Err("recognition token is not canonical".to_string());
    }
    Ok(RecognitionIdentity {
        receipt_id: receipt_id.to_string(),
        recognition_token: recognition_token.to_string(),
    })
}

fn observation_class(observation: &RecognitionObservation, sealed: &SealedScope) -> &'static str {
    if observation.scan_source == ScanSource::NoCandidateBlock {
        return "no_candidate_block";
    }
    if observation.observed_markers.is_empty() {
        return "no_marker";
    }
    if observation
        .observed_markers
        .iter()
        .any(|marker| matches!(marker, ObservedMarker::Malformed { .. }))
    {
        return "malformed";
    }
    let valid = observation
        .observed_markers
        .iter()
        .filter_map(|marker| match marker {
            ObservedMarker::Valid { identity } => Some(identity),
            ObservedMarker::Malformed { .. } => None,
        })
        .collect::<Vec<_>>();
    if valid.len() != 1 {
        return "duplicate_valid";
    }
    if valid[0].receipt_id != sealed.receipt_id {
        return "foreign_receipt";
    }
    if valid[0].recognition_token != sealed.recognition_token {
        return "matching_receipt_wrong_token";
    }
    "single_valid_stored_marker"
}

fn delivery_evidence(observation: &RecognitionObservation) -> &'static str {
    if !observation.may_have_replied && observation.ack.is_none() {
        "missing"
    } else {
        "ok"
    }
}

fn metadata_class(observation: &RecognitionObservation) -> &'static str {
    let consistent = match observation.scan_source {
        ScanSource::NoCandidateBlock => {
            observation.scanned_identity.is_none()
                && observation.scanned_bytes_sha256.is_none()
                && observation.scanned_kind.is_none()
                && observation.observed_markers.is_empty()
                && matches!(
                    (observation.scanned_role, observation.native_user_index),
                    (Some(Role::User), Some(0)) | (None, None)
                )
        }
        ScanSource::DirectScalar | ScanSource::TextBlock => {
            observation.scanned_identity.is_some()
                && observation.scanned_bytes_sha256.is_some()
                && observation.scanned_role == Some(Role::User)
                && observation.scanned_kind == Some(BlockKind::Text)
                && observation.native_user_index == Some(0)
        }
        ScanSource::ToolResult | ScanSource::Other { .. } => false,
    };
    if consistent {
        "consistent"
    } else {
        "inconsistent"
    }
}

fn candidate_class(
    scope: ScopeState,
    observation: &RecognitionObservation,
    candidate: Option<&SuccessorCandidate>,
    sealed: &SealedScope,
) -> &'static str {
    let Some(candidate) = candidate else {
        return "none";
    };
    match scope {
        ScopeState::Absent => "other",
        ScopeState::Redeemed => {
            if candidate.continuation_identity != sealed.stored_edge.continuation_identity {
                "continuation_mismatch"
            } else if candidate.native_continuation_identity
                != sealed.stored_edge.native_continuation_identity
            {
                "native_mismatch"
            } else if candidate.successor_key == sealed.stored_edge.successor_key {
                "stored_edge_equal"
            } else {
                "other"
            }
        }
        ScopeState::Sealed => {
            let observed_identity = observation.observed_markers.iter().find_map(|marker| {
                if let ObservedMarker::Valid { identity } = marker {
                    Some(identity)
                } else {
                    None
                }
            });
            let Some(observed_identity) = observed_identity else {
                return "other";
            };
            if candidate.continuation_identity != *observed_identity {
                "continuation_mismatch"
            } else if observation.scanned_identity.as_ref()
                != Some(&candidate.native_continuation_identity)
            {
                "native_mismatch"
            } else if candidate.successor_key == sealed.stored_edge.successor_key {
                "observation_consistent"
            } else {
                "other"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct PreconditionCell {
    scope_state: String,
    observation_class: String,
    candidate: String,
    delivery_evidence: String,
    metadata: String,
    candidate_scope: String,
}

fn candidate_scope_class(facts: &CandidateScopeFacts) -> Result<&'static str, String> {
    let counts = [
        facts.source_uploads_live,
        facts.attempts_prepared_or_later,
        facts.in_edges,
        facts.out_edges,
    ];
    match facts.row {
        CandidateScopeRow::Absent => {
            if facts.lineage_relation.is_some() || counts.iter().any(|count| *count != 0) {
                Err("an absent candidate scope cannot carry lineage or occupancy facts".to_string())
            } else {
                Ok("absent")
            }
        }
        CandidateScopeRow::Present => {
            if facts.lineage_relation.is_none() {
                Err("a present candidate scope requires lineage_relation".to_string())
            } else if counts.iter().all(|count| *count == 0) {
                Ok("placeholder")
            } else {
                Ok("occupied")
            }
        }
    }
}

fn row_matches(row: &PrecedenceRow, cell: &PreconditionCell) -> bool {
    row.preconditions.scope_state.contains(&cell.scope_state)
        && row
            .preconditions
            .observation_class
            .contains(&cell.observation_class)
        && row.preconditions.candidate.contains(&cell.candidate)
        && row
            .preconditions
            .delivery_evidence
            .contains(&cell.delivery_evidence)
        && row.preconditions.metadata.contains(&cell.metadata)
        && row
            .preconditions
            .candidate_scope
            .contains(&cell.candidate_scope)
}

fn outcome_signature(result: &RedeemResult) -> OutcomeSignature<'_> {
    match result {
        RedeemResult::Redeemed {
            receipt_id,
            edge,
            existing,
            fence_generation,
            lineage_adopted_from,
        } => {
            assert!(valid_uuid36(receipt_id));
            assert!(valid_uuid36(&edge.edge_id));
            assert!(valid_uuid36(&edge.lineage_id));
            assert!(!edge.predecessor_key.is_empty());
            assert!(!edge.successor_key.is_empty());
            assert!(!edge.agent.is_empty());
            assert_eq!(edge.fingerprint.digest.len(), 64);
            assert_eq!(edge.fingerprint.normalization_version, 1);
            assert!(edge.fingerprint.excluded_additions.is_empty());
            assert!(edge.native_continuation_identity.ordinal > 0);
            assert!(*fence_generation > 0);
            if let Some(lineage_id) = lineage_adopted_from {
                assert!(valid_uuid36(lineage_id));
            }
            let _ = existing;
            OutcomeSignature {
                variant: "REDEEMED",
                reason_or_cause: None,
            }
        }
        RedeemResult::Unrecognized { receipt_id, cause } => {
            assert!(valid_uuid36(receipt_id));
            OutcomeSignature {
                variant: "UNRECOGNIZED",
                reason_or_cause: Some(cause.wire_name()),
            }
        }
        RedeemResult::Refused { refusal } => {
            if let Some(receipt_id) = &refusal.receipt_id {
                assert!(valid_uuid36(receipt_id));
            }
            match &refusal.details {
                RefusalDetails::None => {}
                RefusalDetails::Field { field, reason } => {
                    assert!(!field.is_empty());
                    assert!(!reason.is_empty());
                }
                RefusalDetails::Winner { receipt_id } => assert!(valid_uuid36(receipt_id)),
                RefusalDetails::ResolvedAbsent {
                    attempt_id,
                    incarnation,
                } => {
                    assert!(!attempt_id.is_empty());
                    assert!(*incarnation > 0);
                }
                RefusalDetails::Cap {
                    cap,
                    actual,
                    limit,
                    units,
                } => {
                    assert!(!cap.is_empty());
                    assert!(!units.is_empty());
                    assert!(actual >= limit);
                }
                RefusalDetails::Upload {
                    upload_id,
                    seq,
                    declared_digest,
                    actual_digest,
                } => {
                    assert!(upload_id.is_some() || seq.is_some());
                    assert!(declared_digest.is_some() || actual_digest.is_some());
                }
            }
            OutcomeSignature {
                variant: "REFUSED",
                reason_or_cause: Some(refusal.reason.wire_name()),
            }
        }
        RedeemResult::LineageCorrupt { receipt_id } => {
            assert!(valid_uuid36(receipt_id));
            OutcomeSignature {
                variant: "lineage_corrupt",
                reason_or_cause: None,
            }
        }
    }
}

fn assert_source_and_token_provenance(
    vector: &Vector,
    observation: &RecognitionObservation,
    token_inputs: &BTreeMap<&str, [u8; 12]>,
) {
    assert_eq!(
        observation.scanned_bytes_sha256, vector.scanned_material.scanned_bytes_sha256,
        "{} digest provenance disagrees with request",
        vector.id
    );
    if let (Some(source_text), Some(expected_digest)) = (
        vector.scanned_material.source_text.as_deref(),
        observation.scanned_bytes_sha256.as_deref(),
    ) {
        assert_eq!(
            sha256_hex(source_text.as_bytes()),
            expected_digest,
            "{} scanned digest is not the source_text SHA-256",
            vector.id
        );
    }

    let source_text = vector.scanned_material.source_text.as_deref().unwrap_or("");
    for marker in &observation.observed_markers {
        match marker {
            ObservedMarker::Valid { identity } => {
                let marker_text = format!(
                    " mc-d5:{}:{}",
                    identity.receipt_id, identity.recognition_token
                );
                assert!(
                    source_text.contains(&marker_text),
                    "{} marker absent from source",
                    vector.id
                );
                assert_eq!(parse_marker(&marker_text).as_ref(), Ok(identity));
                let decoded = decode_base32_96(&identity.recognition_token)
                    .unwrap_or_else(|error| panic!("{} valid token: {error}", vector.id));
                assert_eq!(
                    token_inputs.get(identity.recognition_token.as_str()),
                    Some(&decoded),
                    "{} token lacks fixed 96-bit provenance",
                    vector.id
                );
            }
            ObservedMarker::Malformed { token_prefix } => {
                assert!(
                    source_text.contains(token_prefix),
                    "{} malformed bytes absent",
                    vector.id
                );
                let error = parse_marker(token_prefix).unwrap_err();
                let expected_error = if vector.name.contains("missing leading space") {
                    "missing its required leading space"
                } else if vector.name.contains("wrong length") {
                    "must be 64 bytes"
                } else if vector.name.contains("non-canonical") {
                    "non-zero canonical padding bits"
                } else if vector.name.contains("non-lowercase") {
                    "not lowercase RFC4648 base32"
                } else if vector.name.contains("bad UUID") {
                    "not lowercase UUID36"
                } else {
                    panic!("{} has an unnamed malformed criterion", vector.id);
                };
                assert!(
                    error.contains(expected_error),
                    "{} malformed criterion was not distinguished: {error}",
                    vector.id
                );
            }
        }
    }
}

fn assert_immutable_specimen_files(index: &Value) {
    let expected = [
        (
            "source-segment-v1.json",
            297_346_u64,
            "25f8d16852703115b3d4b3d35517c79b07b1d7d0360e0c8c013a97dd53e55969",
        ),
        (
            "expected-manifest-v1.json",
            200_274,
            "fa9219cdd34043610164cdfdb001096a3d7bf8db2f48529a49781835dc02db70",
        ),
        (
            "expected-archive-v1.json",
            695_469,
            "7759de3b0169a80cc1be4697474a4fdb5c2c073871eb0857c182f1c6b372eb8e",
        ),
        (
            "canonical-json-vectors-v1.json",
            24_145,
            "8fc5b1b90997378941534bd5a0d88bebd6b10282f030ad25315612d77285f012",
        ),
    ];
    let entries = index["files"].as_array().expect("index files array");
    for (path, byte_size, digest) in expected {
        let entry = entries
            .iter()
            .find(|entry| entry["path"] == path)
            .unwrap_or_else(|| panic!("missing immutable index entry {path}"));
        assert_eq!(entry["byte_size"], byte_size);
        assert_eq!(entry["sha256"], digest);
    }
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let fixture_bytes =
        fs::read(fixture_dir().join("redeem-vectors-v1.json")).expect("read D5 redeem vectors");
    let fixture = serde_json::from_slice(&fixture_bytes).expect("parse fixture schema");
    (fixture, fixture_bytes)
}

fn assert_precondition_space(space: &PreconditionSpace) {
    assert_eq!(
        space.evaluation_order,
        [
            "scope_state",
            "delivery_evidence",
            "metadata",
            "observation_class",
            "candidate",
            "candidate_scope"
        ]
    );
    assert_eq!(
        space.dimensions.scope_state,
        ["absent", "SEALED", "REDEEMED"]
    );
    assert_eq!(
        space.dimensions.observation_class,
        [
            "no_candidate_block",
            "no_marker",
            "malformed",
            "duplicate_valid",
            "foreign_receipt",
            "matching_receipt_wrong_token",
            "single_valid_stored_marker"
        ]
    );
    assert_eq!(space.dimensions.delivery_evidence, ["ok", "missing"]);
    assert_eq!(space.dimensions.metadata, ["consistent", "inconsistent"]);
    assert_eq!(
        space.dimensions.candidate_scope,
        ["absent", "placeholder", "occupied"]
    );
    assert_eq!(
        space.dimensions.candidate_by_scope["absent"],
        ["none", "other"]
    );
    assert_eq!(
        space.dimensions.candidate_by_scope["SEALED"],
        [
            "none",
            "observation_consistent",
            "continuation_mismatch",
            "native_mismatch",
            "other"
        ]
    );
    assert_eq!(
        space.dimensions.candidate_by_scope["REDEEMED"],
        [
            "none",
            "stored_edge_equal",
            "continuation_mismatch",
            "native_mismatch",
            "other"
        ]
    );
    assert!(space.delivery_evidence_rule.contains("exactly when"));
    assert!(space.metadata_rule.contains("All other schema-valid"));
    assert!(space.candidate_scope_rule.contains("derive placeholder"));
    assert!(space.candidate_scope_rule.contains("lineage_relation"));
    assert!(space.candidate_scope_rule.contains("source_uploads_live"));
    assert!(!space.candidate_scope_rule.contains("tickets_bound"));
}

fn precondition_cells(space: &PreconditionSpace) -> Vec<PreconditionCell> {
    let mut cells = Vec::new();
    for scope in &space.dimensions.scope_state {
        for observation in &space.dimensions.observation_class {
            for candidate in &space.dimensions.candidate_by_scope[scope] {
                for delivery in &space.dimensions.delivery_evidence {
                    for metadata in &space.dimensions.metadata {
                        for candidate_scope in &space.dimensions.candidate_scope {
                            cells.push(PreconditionCell {
                                scope_state: scope.clone(),
                                observation_class: observation.clone(),
                                candidate: candidate.clone(),
                                delivery_evidence: delivery.clone(),
                                metadata: metadata.clone(),
                                candidate_scope: candidate_scope.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
    cells
}

fn values(values: &[String]) -> BTreeSet<&str> {
    values.iter().map(String::as_str).collect()
}

fn assert_regardless_markers(fixture: &Fixture) {
    let allowed_names = [
        "observation_class",
        "candidate",
        "delivery_evidence",
        "metadata",
        "candidate_scope",
    ];
    for row in &fixture.precedence_table {
        assert_eq!(
            row.preconditions.scope_state.len(),
            1,
            "{} scope",
            row.row_id
        );
        let scope = &row.preconditions.scope_state[0];
        let dimensions = [
            (
                "observation_class",
                values(&row.preconditions.observation_class),
                values(&fixture.precondition_space.dimensions.observation_class),
            ),
            (
                "candidate",
                values(&row.preconditions.candidate),
                values(&fixture.precondition_space.dimensions.candidate_by_scope[scope]),
            ),
            (
                "delivery_evidence",
                values(&row.preconditions.delivery_evidence),
                values(&fixture.precondition_space.dimensions.delivery_evidence),
            ),
            (
                "metadata",
                values(&row.preconditions.metadata),
                values(&fixture.precondition_space.dimensions.metadata),
            ),
            (
                "candidate_scope",
                values(&row.preconditions.candidate_scope),
                values(&fixture.precondition_space.dimensions.candidate_scope),
            ),
        ];
        assert!(row
            .applies_regardless_of
            .iter()
            .all(|name| allowed_names.contains(&name.as_str())));
        for (name, covered, domain) in dimensions {
            assert_eq!(
                row.applies_regardless_of
                    .iter()
                    .any(|marked| marked == name),
                covered == domain,
                "{} must explicitly mark exactly the dimensions it covers regardless of",
                row.row_id
            );
        }
    }
}

fn uncovered_cells(space: &PreconditionSpace, rows: &[PrecedenceRow]) -> Vec<PreconditionCell> {
    precondition_cells(space)
        .into_iter()
        .filter(|cell| !rows.iter().any(|row| row_matches(row, cell)))
        .collect()
}

fn overlapping_cells(
    space: &PreconditionSpace,
    rows: &[PrecedenceRow],
) -> Vec<(PreconditionCell, Vec<String>)> {
    precondition_cells(space)
        .into_iter()
        .filter_map(|cell| {
            let matches = rows
                .iter()
                .filter(|row| row_matches(row, &cell))
                .map(|row| row.row_id.clone())
                .collect::<Vec<_>>();
            (matches.len() > 1).then_some((cell, matches))
        })
        .collect()
}

#[test]
fn d5_redeem_precedence_table_is_total() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    assert_regardless_markers(&fixture);
    assert_eq!(
        uncovered_cells(&fixture.precondition_space, &fixture.precedence_table),
        [],
        "precedence table has uncovered cells"
    );
}

#[test]
fn d5_redeem_precedence_table_is_disjoint() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    assert_eq!(
        overlapping_cells(&fixture.precondition_space, &fixture.precedence_table),
        [],
        "precedence table has overlapping rows"
    );
}

#[test]
fn d5_redeem_row_deletion_names_the_uncovered_candidate_scope_cell() {
    let (fixture, _) = load_fixture();
    let rows = fixture
        .precedence_table
        .iter()
        .filter(|row| row.row_id != "P20_sealed_candidate_scope_occupied")
        .cloned()
        .collect::<Vec<_>>();
    let uncovered = uncovered_cells(&fixture.precondition_space, &rows);
    assert!(!uncovered.is_empty());
    assert!(uncovered.iter().all(|cell| {
        cell.scope_state == "SEALED"
            && cell.observation_class == "single_valid_stored_marker"
            && cell.candidate == "observation_consistent"
            && cell.delivery_evidence == "ok"
            && cell.metadata == "consistent"
            && cell.candidate_scope == "occupied"
    }));
}

#[test]
fn d5_redeem_overlap_names_both_candidate_scope_rows() {
    let (fixture, _) = load_fixture();
    let mut rows = fixture.precedence_table.clone();
    let mut duplicate = rows
        .iter()
        .find(|row| row.row_id == "P20_sealed_candidate_scope_occupied")
        .expect("occupied row")
        .clone();
    duplicate.row_id = "MUTANT_occupied_as_placeholder".to_string();
    rows.push(duplicate);
    let overlaps = overlapping_cells(&fixture.precondition_space, &rows);
    assert!(!overlaps.is_empty());
    assert!(overlaps.iter().all(|(cell, matching)| {
        cell.candidate_scope == "occupied"
            && matching
                == &[
                    "P20_sealed_candidate_scope_occupied".to_string(),
                    "MUTANT_occupied_as_placeholder".to_string(),
                ]
    }));
}

fn generated_marker_lists(sealed: &SealedScope) -> Vec<Vec<ObservedMarker>> {
    let stored = RecognitionIdentity {
        receipt_id: sealed.receipt_id.clone(),
        recognition_token: sealed.recognition_token.clone(),
    };
    let wrong_token = RecognitionIdentity {
        receipt_id: sealed.receipt_id.clone(),
        recognition_token: "77xn3tf3vkmyq53gkvca".to_string(),
    };
    let foreign = RecognitionIdentity {
        receipt_id: "8d1bb6a0-5678-4cde-9abc-fedcba987654".to_string(),
        recognition_token: "caqdaqcqmbyibefawdaa".to_string(),
    };
    vec![
        vec![],
        vec![ObservedMarker::Malformed {
            token_prefix: "mc-d5:malformed".to_string(),
        }],
        vec![ObservedMarker::Valid {
            identity: stored.clone(),
        }],
        vec![ObservedMarker::Valid {
            identity: wrong_token,
        }],
        vec![ObservedMarker::Valid { identity: foreign }],
        vec![
            ObservedMarker::Valid {
                identity: stored.clone(),
            },
            ObservedMarker::Valid {
                identity: stored.clone(),
            },
        ],
        vec![
            ObservedMarker::Malformed {
                token_prefix: " mc-d5:truncated".to_string(),
            },
            ObservedMarker::Valid {
                identity: stored.clone(),
            },
        ],
        vec![
            ObservedMarker::Valid {
                identity: stored.clone(),
            },
            ObservedMarker::Valid {
                identity: stored.clone(),
            },
            ObservedMarker::Valid { identity: stored },
        ],
    ]
}

fn generated_candidate_scope_facts() -> Vec<CandidateScopeFacts> {
    vec![
        CandidateScopeFacts::default(),
        CandidateScopeFacts {
            row: CandidateScopeRow::Present,
            lineage_relation: Some(LineageRelation::Predecessor),
            source_uploads_live: 0,
            attempts_prepared_or_later: 0,
            in_edges: 0,
            out_edges: 0,
        },
        CandidateScopeFacts {
            row: CandidateScopeRow::Present,
            lineage_relation: Some(LineageRelation::Other),
            source_uploads_live: 0,
            attempts_prepared_or_later: 1,
            in_edges: 0,
            out_edges: 0,
        },
    ]
}

#[test]
fn d5_candidate_scope_classifier_derives_raw_occupancy_facts() {
    let count_values = [0, 1, u64::MAX];
    for lineage_relation in [LineageRelation::Predecessor, LineageRelation::Other] {
        for uploads in count_values {
            for attempts in count_values {
                for in_edges in count_values {
                    for out_edges in count_values {
                        let facts = CandidateScopeFacts {
                            row: CandidateScopeRow::Present,
                            lineage_relation: Some(lineage_relation),
                            source_uploads_live: uploads,
                            attempts_prepared_or_later: attempts,
                            in_edges,
                            out_edges,
                        };
                        let expected = if [uploads, attempts, in_edges, out_edges]
                            .iter()
                            .all(|count| *count == 0)
                        {
                            "placeholder"
                        } else {
                            "occupied"
                        };
                        assert_eq!(candidate_scope_class(&facts), Ok(expected));
                    }
                }
            }
        }
    }
    assert_eq!(
        candidate_scope_class(&CandidateScopeFacts::default()),
        Ok("absent")
    );
    let invalid_absent = CandidateScopeFacts {
        in_edges: 1,
        ..CandidateScopeFacts::default()
    };
    assert!(candidate_scope_class(&invalid_absent).is_err());
}

fn generated_candidate_shapes(sealed: &SealedScope) -> Vec<Option<SuccessorCandidate>> {
    let exact = SuccessorCandidate {
        successor_key: sealed.stored_edge.successor_key.clone(),
        native_continuation_identity: sealed.stored_edge.native_continuation_identity.clone(),
        continuation_identity: sealed.stored_edge.continuation_identity.clone(),
    };
    let mut continuation_mismatch = exact.clone();
    continuation_mismatch
        .continuation_identity
        .recognition_token = "77xn3tf3vkmyq53gkvca".to_string();
    let mut native_mismatch = exact.clone();
    native_mismatch.native_continuation_identity.mid = "mid-successor-user-0002".to_string();
    let mut other = exact.clone();
    other.successor_key = "session-successor-0002".to_string();
    vec![
        None,
        Some(exact),
        Some(continuation_mismatch),
        Some(native_mismatch),
        Some(other),
    ]
}

#[test]
fn d5_redeem_classifiers_cover_schema_valid_request_grammar() {
    let (fixture, _) = load_fixture();
    let domain = precondition_cells(&fixture.precondition_space)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let identities = [
        None,
        Some(
            fixture
                .sealed_scope
                .stored_edge
                .native_continuation_identity
                .clone(),
        ),
    ];
    let digests = [None, Some("00".repeat(32))];
    let roles = [None, Some(Role::User)];
    let kinds = [None, Some(BlockKind::Text)];
    let indices = [None, Some(0)];
    let scan_sources = [
        ScanSource::DirectScalar,
        ScanSource::TextBlock,
        ScanSource::ToolResult,
        ScanSource::NoCandidateBlock,
        ScanSource::Other {
            source: "schema-valid-other".to_string(),
        },
    ];
    let marker_lists = generated_marker_lists(&fixture.sealed_scope);
    let candidate_shapes = generated_candidate_shapes(&fixture.sealed_scope);
    let candidate_scope_facts = generated_candidate_scope_facts();
    let delivery_shapes = [
        (false, None),
        (true, None),
        (false, Some("durable-ack".to_string())),
        (true, Some("durable-ack".to_string())),
    ];
    let scopes = [ScopeState::Absent, ScopeState::Sealed, ScopeState::Redeemed];
    let mut observed_classes = BTreeMap::<&str, BTreeSet<String>>::new();

    for candidate_scope in &candidate_scope_facts {
        for scope in scopes {
            for scanned_identity in &identities {
                for scanned_digest in &digests {
                    for scanned_role in roles {
                        for scanned_kind in kinds {
                            for native_user_index in indices {
                                for scan_source in &scan_sources {
                                    for observed_markers in &marker_lists {
                                        for candidate in &candidate_shapes {
                                            for (may_have_replied, ack) in &delivery_shapes {
                                                let request = LineageRequest::Redeem {
                                                    predecessor_key: "session-predecessor-0001"
                                                        .to_string(),
                                                    agent: "agent-main".to_string(),
                                                    incarnation: 7,
                                                    observation: RecognitionObservation {
                                                        scanned_identity: scanned_identity.clone(),
                                                        scanned_bytes_sha256: scanned_digest
                                                            .clone(),
                                                        scanned_role,
                                                        scanned_kind,
                                                        native_user_index,
                                                        scan_source: scan_source.clone(),
                                                        observed_markers: observed_markers.clone(),
                                                        may_have_replied: *may_have_replied,
                                                        ack: ack.clone(),
                                                    },
                                                    candidate: candidate.clone(),
                                                };
                                                let wire = serde_json::to_value(&request)
                                                    .expect("serialize generated request");
                                                let decoded: LineageRequest =
                                                    serde_json::from_value(wire)
                                                        .expect("generated request follows schema");
                                                let LineageRequest::Redeem {
                                                    observation,
                                                    candidate,
                                                    ..
                                                } = decoded;
                                                let cell = PreconditionCell {
                                                    scope_state: scope.wire_name().to_string(),
                                                    observation_class: observation_class(
                                                        &observation,
                                                        &fixture.sealed_scope,
                                                    )
                                                    .to_string(),
                                                    candidate: candidate_class(
                                                        scope,
                                                        &observation,
                                                        candidate.as_ref(),
                                                        &fixture.sealed_scope,
                                                    )
                                                    .to_string(),
                                                    delivery_evidence: delivery_evidence(
                                                        &observation,
                                                    )
                                                    .to_string(),
                                                    metadata: metadata_class(&observation)
                                                        .to_string(),
                                                    candidate_scope: candidate_scope_class(
                                                        candidate_scope,
                                                    )
                                                    .expect("generated candidate scope facts")
                                                    .to_string(),
                                                };
                                                assert_eq!(
                                                domain.iter().filter(|known| *known == &cell).count(),
                                                1,
                                                "schema-valid request did not classify into exactly one domain cell: {cell:?}"
                                            );
                                                for (dimension, label) in [
                                                    ("scope_state", cell.scope_state),
                                                    ("observation_class", cell.observation_class),
                                                    ("candidate", cell.candidate),
                                                    ("delivery_evidence", cell.delivery_evidence),
                                                    ("metadata", cell.metadata),
                                                    ("candidate_scope", cell.candidate_scope),
                                                ] {
                                                    observed_classes
                                                        .entry(dimension)
                                                        .or_default()
                                                        .insert(label);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let expected_classes = [
        (
            "scope_state",
            values(&fixture.precondition_space.dimensions.scope_state),
        ),
        (
            "observation_class",
            values(&fixture.precondition_space.dimensions.observation_class),
        ),
        (
            "candidate",
            fixture
                .precondition_space
                .dimensions
                .candidate_by_scope
                .values()
                .flatten()
                .map(String::as_str)
                .collect(),
        ),
        (
            "delivery_evidence",
            values(&fixture.precondition_space.dimensions.delivery_evidence),
        ),
        (
            "metadata",
            values(&fixture.precondition_space.dimensions.metadata),
        ),
        (
            "candidate_scope",
            values(&fixture.precondition_space.dimensions.candidate_scope),
        ),
    ];
    for (dimension, expected) in expected_classes {
        let observed = observed_classes
            .get(dimension)
            .expect("classifier dimension was exercised")
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            observed, expected,
            "classifier grammar labels for {dimension}"
        );
    }
}

fn fixture_vector<'a>(fixture: &'a Fixture, id: &str) -> &'a Vector {
    fixture
        .vectors
        .iter()
        .find(|vector| vector.id == id)
        .unwrap_or_else(|| panic!("missing vector {id}"))
}

/// The request the model is fed and the keyed response envelope the step pins.
/// A redeem step borrows both from the vector it names.
fn sequence_step_wire(
    fixture: &Fixture,
    step: &SequenceStep,
    label: &str,
) -> (Vec<u8>, Option<Vec<u8>>) {
    match (
        step.vector_id.as_deref(),
        step.request_bytes_base64.as_deref(),
    ) {
        (Some(id), None) => {
            let vector = fixture_vector(fixture, id);
            let request = vector
                .request_bytes_base64
                .as_deref()
                .unwrap_or_else(|| panic!("{label}: vector {id} pins no request bytes"));
            let expected = vector
                .expected_bytes_base64
                .as_deref()
                .unwrap_or_else(|| panic!("{label}: vector {id} pins no response bytes"));
            assert_eq!(
                step.response_bytes_base64.as_deref(),
                Some(expected),
                "{label}: the step and vector {id} pin different response bytes"
            );
            (decode_base64(request), Some(decode_base64(expected)))
        }
        (None, Some(request)) => (
            decode_base64(request),
            step.response_bytes_base64.as_deref().map(decode_base64),
        ),
        _ => panic!("{label}: a step names exactly one of vector_id or request_bytes_base64"),
    }
}

/// Decode the pinned result with the contract's own result type for that op, so
/// an expectation that is merely plausible JSON cannot pass as a typed result.
fn assert_result_decodes(op: &str, bytes: &[u8], label: &str) {
    fn check<T: serde::de::DeserializeOwned>(bytes: &[u8], label: &str, type_name: &str) {
        serde_json::from_slice::<T>(bytes).unwrap_or_else(|error| {
            panic!("{label}: the pinned result does not decode as {type_name}: {error}")
        });
    }
    match op {
        "scope.open" => check::<d5_scope_model::ScopeResult>(bytes, label, "ScopeResult"),
        "attempt.ticket" => check::<d5_scope_model::TicketResult>(bytes, label, "TicketResult"),
        "redeem" => check::<d5_scope_model::RedeemResult>(bytes, label, "RedeemResult"),
        "prepare" => check::<d5_scope_model::PrepareResult>(bytes, label, "PrepareResult"),
        "attempt.resolve" => check::<d5_scope_model::ResolveResult>(bytes, label, "ResolveResult"),
        "lineage.begin" | "capacity.begin" => {
            check::<d5_scope_model::BeginResult>(bytes, label, "BeginResult")
        }
        "capacity.put" => check::<d5_scope_model::PutResult>(bytes, label, "PutResult"),
        "capacity.finish" => check::<d5_scope_model::FinishResult>(bytes, label, "FinishResult"),
        "capacity.check" => check::<d5_scope_model::CapacityResult>(bytes, label, "CapacityResult"),
        other => panic!("{label}: no result type is bound to op {other}"),
    }
}

/// Where the generation proof is allowed to live, asserted on what the model
/// produced rather than on what the fixture holds: prepare and attempt.resolve
/// carry it inside their attempt outcome, and the refused source upload carries
/// no proof at all, because BeginResult has nowhere to put one.
fn assert_generation_proof_placement(produced: &[(String, Value)]) {
    let first = |op: &str| {
        produced
            .iter()
            .find(|(name, _)| name == op)
            .map(|(_, value)| value)
            .unwrap_or_else(|| panic!("S03 produced no {op} result"))
    };
    let prepare = first("prepare");
    let resolve = first("attempt.resolve");
    let begin = first("lineage.begin");

    for (op, result) in [("prepare", prepare), ("attempt.resolve", resolve)] {
        let outcome = &result["attempt_outcome"];
        assert_eq!(
            outcome["refusal"]["reason"], "resolved_absent",
            "{op} refusal reason"
        );
        assert_eq!(
            outcome["negative"]["kind"], "generation_fence",
            "{op} negative proof"
        );
        assert_eq!(outcome["negative"]["incarnation"], 3, "{op} incarnation");
        assert_eq!(
            outcome["negative"]["invalidated_ticket_generation"], 6,
            "{op} invalidated generation"
        );
        assert_eq!(outcome["negative"]["fenced_by"], 7, "{op} fenced_by");
        assert!(
            result.get("negative").is_none(),
            "{op} must not repeat the proof beside its outcome"
        );
    }
    assert!(
        prepare.get("kind").is_none(),
        "PrepareResult is a struct with an attempt_outcome, not a tagged union"
    );
    assert_eq!(resolve["kind"], "RESOLVED");
    assert!(
        !resolve["attempt_outcome"].is_null(),
        "a fenced attempt resolves terminally and is never returned as UNKNOWN"
    );
    assert_eq!(
        resolve["resolve_generation"], 7,
        "the replay never re-bumps"
    );

    assert_eq!(begin["kind"], "REFUSED");
    assert_eq!(begin["refusal"]["reason"], "ticket_invalid");
    assert!(
        begin.get("negative").is_none()
            && begin["refusal"].get("negative").is_none()
            && begin["refusal"]["details"].get("negative").is_none(),
        "BeginResult has no placement for a negative proof and must not grow one"
    );
}

#[test]
fn d5_redeem_r47_sequences_execute_against_the_reference_model() {
    let (fixture, _) = load_fixture();
    for preimage in &fixture.r47_specimen_preimages {
        assert_eq!(
            sha256_hex(preimage.preimage_utf8.as_bytes()),
            preimage.value,
            "authored specimen digest does not hash its recorded preimage"
        );
        assert!(!preimage.usage.is_empty());
    }
    assert_eq!(
        fixture
            .r47_sequences
            .iter()
            .map(|sequence| sequence.id.as_str())
            .collect::<Vec<_>>(),
        [
            "S01_adoption_replay",
            "S02_adoption_then_scope_open",
            "S03_generation_fence",
            "S04_concurrent_open_pre_adoption",
            "S05_concurrent_open_post_adoption",
            "S06_capacity_upload_survives_adoption",
        ]
    );

    for sequence in &fixture.r47_sequences {
        assert!(
            !sequence.name.is_empty() && !sequence.note.is_empty(),
            "{} needs a name and a note",
            sequence.id
        );
        // Every sequence starts from the same authored world and then runs.
        let mut model = ScopeModel::new(&fixture.r47_model_seed);
        let mut produced: Vec<(String, Value)> = Vec::new();
        for (index, step) in sequence.steps.iter().enumerate() {
            let label = format!("{} step {index} ({})", sequence.id, step.op);
            if let Some(note) = &step.note {
                assert!(!note.is_empty(), "{label}: empty note");
            }
            let (request_bytes, response_bytes) = sequence_step_wire(&fixture, step, &label);
            let request = ModelRequest::decode(&request_bytes)
                .unwrap_or_else(|error| panic!("{label}: request does not decode: {error}"));
            assert_eq!(
                request.op(),
                step.op,
                "{label}: the step names an op its request does not carry"
            );

            let outcome = model.run(&request);
            let expected_result = step.result_bytes_base64.as_deref().map(decode_base64);
            match (outcome.wire_result(), expected_result) {
                (Some(actual), Some(expected)) => {
                    assert_eq!(
                        String::from_utf8_lossy(&actual),
                        String::from_utf8_lossy(&expected),
                        "{label}: the model produced different result bytes"
                    );
                    assert_result_decodes(&step.op, &expected, &label);
                    let envelope = response_bytes.unwrap_or_else(|| {
                        panic!("{label}: a wire result needs its response bytes")
                    });
                    decode_keyed_response(&envelope, request.response_wire_key(), &actual)
                        .unwrap_or_else(|error| {
                            panic!("{label}: the keyed response envelope does not wrap this result: {error}")
                        });
                    produced.push((
                        step.op.clone(),
                        serde_json::from_slice(&actual).expect("model result is JSON"),
                    ));
                }
                (None, None) => {
                    assert!(
                        response_bytes.is_none(),
                        "{label}: a bounded outcome pins no response envelope"
                    );
                    match (&outcome, &step.bounded_outcome) {
                        (
                            StepOutcome::Prepare(PrepareOutcome::Admitted { attempt_id }),
                            Some(BoundedOutcome::PrepareAdmitted {
                                attempt_id: expected,
                                unmodelled_wire_result,
                            }),
                        ) => {
                            assert_eq!(attempt_id, expected, "{label}: admitted attempt");
                            assert!(!unmodelled_wire_result.is_empty());
                        }
                        (
                            StepOutcome::CapacityCheck(CapacityCheckOutcome::Authorized {
                                upload,
                            }),
                            Some(BoundedOutcome::CapacityCheckAuthorized {
                                upload_id,
                                unmodelled_wire_result,
                            }),
                        ) => {
                            assert_eq!(&upload.upload_id, upload_id, "{label}: consumed upload");
                            assert!(!unmodelled_wire_result.is_empty());
                        }
                        (outcome, declared) => panic!(
                            "{label}: the model produced {outcome:?}, which is not the declared {declared:?}"
                        ),
                    }
                }
                (Some(actual), None) => panic!(
                    "{label}: the step declares a bounded outcome but the model produced {}",
                    String::from_utf8_lossy(&actual)
                ),
                (None, Some(expected)) => panic!(
                    "{label}: the step pins {} but the model produced {outcome:?}",
                    String::from_utf8_lossy(&expected)
                ),
            }

            for expected in &step.scopes_after {
                let actual = model
                    .scope_facts(&expected.predecessor_key, &expected.agent)
                    .unwrap_or_else(|| {
                        panic!("{label}: no scope row for {}", expected.predecessor_key)
                    });
                assert_eq!(&actual, expected, "{label}: scope row after the step");
            }
        }
        if sequence.id == "S03_generation_fence" {
            assert_generation_proof_placement(&produced);
        }
    }
}

/// The bytes S03's source-upload step carried while the fixture still put the
/// clause-3 operation label on the wire, kept verbatim so the refusal is proved
/// against an envelope the fixture really held rather than against one rebuilt
/// from the current bytes.
const PRE_R48_S03_BEGIN_REQUEST: &str = r#"{"op":"lineage.begin","attempt":{"predecessor_key":"session-successor-0001","agent":"agent-main","F":{"digest":"6b25e8a6310ebcd4f992ace9c5cd57cf9cbd7a562989bbd8327de247f13e3afe","normalization_version":1,"excluded_additions":[]},"attempt_id":"attempt-s-stale-0001","incarnation":3},"ticket":{"resolve_generation":6,"P":"session-successor-0001","agent":"agent-main","incarnation":3},"kind":"source_segment","total_bytes":1310720,"total_chunks":2,"digest":"468081473a179b44e7a2c76d499f5db8747e6ab78ff040f67eddb3d924fd8d6a"}"#;

/// The S03 steps whose wire discriminator moved: the step's index in the
/// sequence, the clause-3 operation label the step keeps, and the discriminator
/// its request bytes and keyed response envelope both carry.
const S03_WIRE_DISCRIMINATORS: [(usize, &str, &str); 5] = [
    (1, "attempt.ticket", "ticket"),
    (4, "lineage.begin", "begin"),
    (5, "attempt.resolve", "resolve"),
    (6, "attempt.ticket", "ticket"),
    (7, "lineage.begin", "begin"),
];

/// The bytes S03's first ticket step carried while the fixture still put the
/// clause-3 operation label on the keyed response envelope, kept verbatim so
/// the refusal is proved against an envelope the fixture really held rather
/// than against one rebuilt from the current bytes.
const PRE_RESPONSE_KEY_S03_TICKET_ENVELOPE: &str = r#"{"attempt.ticket":{"result":{"kind":"ISSUED","ticket":{"resolve_generation":6,"P":"session-successor-0001","agent":"agent-main","incarnation":3}}}}"#;

fn sequence_by_id<'a>(fixture: &'a Fixture, id: &str) -> &'a R47Sequence {
    fixture
        .r47_sequences
        .iter()
        .find(|sequence| sequence.id == id)
        .unwrap_or_else(|| panic!("fixture has no sequence {id}"))
}

fn step_request_bytes(sequence: &R47Sequence, index: usize) -> Vec<u8> {
    decode_base64(
        sequence.steps[index]
            .request_bytes_base64
            .as_deref()
            .unwrap_or_else(|| panic!("{} step {index} pins no request bytes", sequence.id)),
    )
}

fn step_response_bytes(sequence: &R47Sequence, index: usize) -> Vec<u8> {
    decode_base64(
        sequence.steps[index]
            .response_bytes_base64
            .as_deref()
            .unwrap_or_else(|| panic!("{} step {index} pins no response bytes", sequence.id)),
    )
}

fn step_result_bytes(sequence: &R47Sequence, index: usize) -> Vec<u8> {
    decode_base64(
        sequence.steps[index]
            .result_bytes_base64
            .as_deref()
            .unwrap_or_else(|| panic!("{} step {index} pins no result bytes", sequence.id)),
    )
}

/// The wire grammar names the nine original lineage operations by their short
/// discriminators, so the dotted spellings of clause 3 are operation labels and
/// never wire values. A label on the wire is refused, with no alias and no dual
/// acceptance, while the operations pinned with dotted discriminators keep
/// decoding.
#[test]
fn d5_lineage_request_decoder_refuses_clause_3_labels_on_the_wire() {
    let (fixture, _) = load_fixture();

    let refusal = ModelRequest::decode(PRE_R48_S03_BEGIN_REQUEST.as_bytes())
        .expect_err("an operation label is not a wire discriminator");
    assert!(
        refusal.contains("R48") && refusal.contains("lineage.begin"),
        "the refusal must name the rejected op and the rule that rejects it: {refusal}"
    );

    let s03 = sequence_by_id(&fixture, "S03_generation_fence");
    assert_eq!(
        String::from_utf8(step_request_bytes(s03, 4)).expect("utf8 request"),
        PRE_R48_S03_BEGIN_REQUEST.replace("\"op\":\"lineage.begin\"", "\"op\":\"begin\""),
        "the repair moved the discriminator and nothing else in the envelope"
    );

    for (index, label, discriminator) in S03_WIRE_DISCRIMINATORS {
        assert_eq!(
            s03.steps[index].op, label,
            "S03 step {index} keeps its operation label"
        );
        let bytes = step_request_bytes(s03, index);
        let envelope: Value = serde_json::from_slice(&bytes).expect("request JSON");
        assert_eq!(
            envelope["op"], discriminator,
            "S03 step {index} carries the wire discriminator"
        );
        let request = ModelRequest::decode(&bytes)
            .unwrap_or_else(|error| panic!("S03 step {index} does not decode: {error}"));
        assert_eq!(request.op(), label, "S03 step {index} decodes to its label");

        let relabelled = String::from_utf8(bytes).expect("utf8 request").replacen(
            &format!("\"op\":\"{discriminator}\""),
            &format!("\"op\":\"{label}\""),
            1,
        );
        match ModelRequest::decode(relabelled.as_bytes()) {
            Ok(_) => panic!("S03 step {index} accepts the label {label} on the wire"),
            Err(refusal) => assert!(
                refusal.contains("R48") && refusal.contains(label),
                "S03 step {index} refusal must name {label} and the rule: {refusal}"
            ),
        }
    }

    // Dotted discriminators are not refused as a class: the capacity family and
    // scope.open carry the discriminators they were pinned with.
    for (id, index, discriminator) in [
        ("S03_generation_fence", 0, "scope.open"),
        ("S06_capacity_upload_survives_adoption", 0, "capacity.begin"),
        ("S06_capacity_upload_survives_adoption", 1, "capacity.put"),
    ] {
        let bytes = step_request_bytes(sequence_by_id(&fixture, id), index);
        let envelope: Value = serde_json::from_slice(&bytes).expect("request JSON");
        assert_eq!(envelope["op"], discriminator, "{id} step {index} wire op");
        let request = ModelRequest::decode(&bytes)
            .unwrap_or_else(|error| panic!("{id} step {index} does not decode: {error}"));
        assert_eq!(request.op(), discriminator, "{id} step {index} label");
    }
}

/// The keyed response envelope uses the same short discriminators as the
/// request. A clause-3 label as the outer key is refused even when the inner
/// result bytes still match, with no alias and no dual acceptance.
#[test]
fn d5_lineage_response_decoder_refuses_clause_3_labels_on_the_wire() {
    let (fixture, _) = load_fixture();
    let s03 = sequence_by_id(&fixture, "S03_generation_fence");
    let result = step_result_bytes(s03, 1);

    let refusal = decode_keyed_response(
        PRE_RESPONSE_KEY_S03_TICKET_ENVELOPE.as_bytes(),
        "ticket",
        &result,
    )
    .expect_err("an operation label is not a response key");
    assert!(
        refusal.contains("attempt.ticket") && refusal.contains("not response keys"),
        "the refusal must name the rejected key: {refusal}"
    );
    // Dual acceptance is refused: asking the decoder to expect the label still
    // rejects the label. Inner result bytes are not a substitute for the key.
    let dual = decode_keyed_response(
        PRE_RESPONSE_KEY_S03_TICKET_ENVELOPE.as_bytes(),
        "attempt.ticket",
        &result,
    )
    .expect_err("the label is not accepted as a response key either");
    assert!(
        dual.contains("attempt.ticket"),
        "dual-acceptance refusal must still name the label: {dual}"
    );

    assert_eq!(
        String::from_utf8(step_response_bytes(s03, 1)).expect("utf8 response"),
        PRE_RESPONSE_KEY_S03_TICKET_ENVELOPE.replace("\"attempt.ticket\":", "\"ticket\":"),
        "the response key moved and nothing else in the envelope"
    );

    for (index, label, discriminator) in S03_WIRE_DISCRIMINATORS {
        assert_eq!(
            s03.steps[index].op, label,
            "S03 step {index} keeps its operation label"
        );
        let envelope = step_response_bytes(s03, index);
        let result = step_result_bytes(s03, index);
        let parsed: Value = serde_json::from_slice(&envelope).expect("response JSON");
        let keys: Vec<&str> = parsed
            .as_object()
            .expect("object")
            .keys()
            .map(|key| key.as_str())
            .collect();
        assert_eq!(
            keys,
            [discriminator],
            "S03 step {index} response carries the wire key"
        );
        let request = ModelRequest::decode(&step_request_bytes(s03, index))
            .unwrap_or_else(|error| panic!("S03 step {index} request does not decode: {error}"));
        assert_eq!(request.op(), label, "S03 step {index} keeps its label");
        assert_eq!(
            request.response_wire_key(),
            discriminator,
            "S03 step {index} maps the label onto the wire key"
        );
        decode_keyed_response(&envelope, discriminator, &result)
            .unwrap_or_else(|error| panic!("S03 step {index} response does not decode: {error}"));

        let relabelled = String::from_utf8(envelope)
            .expect("utf8 response")
            .replacen(
                &format!("\"{discriminator}\":"),
                &format!("\"{label}\":"),
                1,
            );
        match decode_keyed_response(relabelled.as_bytes(), discriminator, &result) {
            Ok(_) => panic!("S03 step {index} accepts the label {label} as a response key"),
            Err(refusal) => assert!(
                refusal.contains(label) && refusal.contains("not response keys"),
                "S03 step {index} refusal must name {label}: {refusal}"
            ),
        }
    }
}

#[test]
fn d5_redeem_r47_adoption_is_reported_fenced_and_custody_free() {
    let (fixture, fixture_bytes) = load_fixture();
    assert!(
        !String::from_utf8_lossy(&fixture_bytes).contains("tickets_bound"),
        "MC candidate-scope occupancy must not claim gateway-local tickets"
    );
    let adopted = fixture_vector(&fixture, "V35");
    assert_eq!(
        candidate_scope_class(&adopted.candidate_scope),
        Ok("placeholder")
    );
    assert_eq!(
        adopted.candidate_scope.lineage_relation,
        Some(LineageRelation::Other)
    );
    let transition = adopted.transition.as_ref().expect("adoption transition");
    assert_eq!(transition.incarnation_before, transition.incarnation_after);
    assert_eq!(transition.resolve_generation_before, Some(6));
    assert_eq!(transition.resolve_generation_after, Some(7));
    assert_eq!(
        transition.resolve_generation_after,
        transition
            .resolve_generation_before
            .map(|generation| generation + 1)
    );
    assert_eq!(transition.lineage_id_before, transition.placeholder_retired);
    assert_eq!(
        transition.lineage_id_after.as_deref(),
        Some(fixture.sealed_scope.stored_edge.lineage_id.as_str())
    );
    assert_eq!(transition.positive_custody_before, 0);
    assert_eq!(transition.positive_custody_after, 0);
    assert_eq!(transition.capacity_uploads_before, 0);
    assert_eq!(transition.capacity_uploads_after, 0);
    assert_eq!(
        transition.predecessor_counter_before,
        transition.predecessor_counter_after
    );
    assert_eq!(adopted.candidate_scope.attempts_prepared_or_later, 0);
    assert_eq!(
        adopted.expected["redeem"]["result"]["lineage_adopted_from"].as_str(),
        transition.lineage_id_before.as_deref()
    );

    let same_lineage = fixture_vector(&fixture, "V36");
    assert_eq!(
        candidate_scope_class(&same_lineage.candidate_scope),
        Ok("placeholder")
    );
    assert_eq!(
        same_lineage.candidate_scope.lineage_relation,
        Some(LineageRelation::Predecessor)
    );
    assert_eq!(
        same_lineage.expected,
        fixture_vector(&fixture, "V15").expected
    );
    assert!(same_lineage.expected["redeem"]["result"]
        .get("lineage_adopted_from")
        .is_none());
    let same_transition = same_lineage
        .transition
        .as_ref()
        .expect("same-lineage transition");
    assert_eq!(
        same_transition.lineage_id_before,
        same_transition.lineage_id_after
    );
    assert_eq!(
        same_transition.resolve_generation_before,
        same_transition.resolve_generation_after
    );
    assert!(same_transition.placeholder_retired.is_none());

    let capacity = fixture_vector(&fixture, "V42");
    assert_eq!(
        candidate_scope_class(&capacity.candidate_scope),
        Ok("placeholder")
    );
    assert_eq!(capacity.precedence_row, "P15_sealed_positive");
    assert_eq!(
        capacity.expected["redeem"]["result"]["lineage_adopted_from"],
        "33333333-4444-4555-8666-777777777777"
    );
    let capacity_transition = capacity.transition.as_ref().expect("capacity transition");
    assert_eq!(capacity_transition.capacity_uploads_before, 1);
    assert_eq!(capacity_transition.capacity_uploads_after, 1);
}

#[test]
fn d5_redeem_r47_occupied_scope_refuses_without_state_change() {
    let (fixture, _) = load_fixture();
    for id in ["V37", "V38", "V40", "V41", "V43"] {
        let vector = fixture_vector(&fixture, id);
        assert_eq!(
            candidate_scope_class(&vector.candidate_scope),
            Ok("occupied"),
            "{id}"
        );
        assert_eq!(
            vector.expected["redeem"]["result"]["kind"], "REFUSED",
            "{id}"
        );
        assert_eq!(
            vector.expected["redeem"]["result"]["refusal"]["details"]["field"], "candidate",
            "{id}"
        );
        assert_eq!(
            vector.expected["redeem"]["result"]["refusal"]["details"]["reason"],
            "candidate scope has its own attempts or descent",
            "{id}"
        );
        let transition = vector.transition.as_ref().expect("occupied transition");
        assert_eq!(
            transition.lineage_id_before, transition.lineage_id_after,
            "{id}"
        );
        assert_eq!(
            transition.incarnation_before, transition.incarnation_after,
            "{id}"
        );
        assert_eq!(
            transition.resolve_generation_before, transition.resolve_generation_after,
            "{id}"
        );
        assert!(transition.placeholder_retired.is_none(), "{id}");
        assert_eq!(
            transition.positive_custody_before, transition.positive_custody_after,
            "{id}"
        );
        assert_eq!(
            transition.capacity_uploads_before, transition.capacity_uploads_after,
            "{id}"
        );
        assert_eq!(
            transition.predecessor_counter_before, transition.predecessor_counter_after,
            "{id}"
        );
    }
    assert!(
        fixture_vector(&fixture, "V37")
            .candidate_scope
            .attempts_prepared_or_later
            > 0
    );
    assert!(fixture_vector(&fixture, "V38").candidate_scope.out_edges > 0);
    assert!(fixture_vector(&fixture, "V40").candidate_scope.in_edges > 0);
    assert_eq!(
        fixture_vector(&fixture, "V40")
            .candidate_scope
            .lineage_relation,
        Some(LineageRelation::Predecessor)
    );
    assert!(
        fixture_vector(&fixture, "V41")
            .candidate_scope
            .source_uploads_live
            > 0
    );
}

#[test]
fn d5_redeem_r47_replay_precedes_candidate_scope_and_has_no_second_adoption() {
    let (fixture, _) = load_fixture();
    let replay = fixture_vector(&fixture, "V39");
    assert_eq!(
        candidate_scope_class(&replay.candidate_scope),
        Ok("occupied")
    );
    assert_eq!(
        replay.precedence_row,
        "P02_redeemed_matching_candidate_and_marker"
    );
    assert_eq!(replay.expected, fixture_vector(&fixture, "V16").expected);
    assert!(replay.expected["redeem"]["result"]
        .get("lineage_adopted_from")
        .is_none());
    let transition = replay.transition.as_ref().expect("replay transition");
    assert_eq!(transition.lineage_id_before, transition.lineage_id_after);
    assert_eq!(
        transition.resolve_generation_before,
        transition.resolve_generation_after
    );
    assert_eq!(
        transition.predecessor_counter_before,
        transition.predecessor_counter_after
    );
    assert_eq!(
        transition.positive_custody_before,
        transition.positive_custody_after
    );
}

#[test]
fn d5_redeem_lineage_adopted_from_present_null_is_rejected() {
    let (fixture, _) = load_fixture();
    let negative = fixture
        .negative_vectors
        .first()
        .expect("present-null negative vector");
    assert_eq!(negative.id, "N01_lineage_adopted_from_null");
    assert!(!negative.name.is_empty());
    assert_eq!(negative.rejected_field, "lineage_adopted_from");
    let error =
        serde_json::from_slice::<LineageResponse>(&decode_base64(&negative.response_bytes_base64))
            .expect_err("present null must not decode as None");
    assert!(error.to_string().contains("string"));
}

#[test]
fn d5_redeem_vectors_agree_with_precedence_table() {
    let (fixture, fixture_bytes) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.redeem-vectors.v1");
    assert!(fixture
        .encoding_rule
        .lineage_request
        .contains("discriminator op"));
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
        .implementation_status
        .contains("slice 2"));
    assert!(fixture.serde_evidence.iter().any(|evidence| {
        evidence.path == "crates/mc-module/src/tail_hygiene.rs"
            && evidence.lines == "1212-1238"
            && evidence.finding.contains("internally tagged")
    }));
    assert_precondition_space(&fixture.precondition_space);

    assert_eq!(fixture.sealed_scope.receipt_id, RECEIPT_ID);
    assert_eq!(fixture.sealed_scope.recognition_token, SEALED_TOKEN);
    assert_eq!(fixture.sealed_scope.fence_generation, 12);
    assert_eq!(
        fixture
            .sealed_scope
            .stored_edge
            .continuation_identity
            .receipt_id,
        RECEIPT_ID
    );

    let mut token_inputs = BTreeMap::new();
    for token in &fixture.token_values {
        assert!(token.round_trip_matches_input);
        let input = hex_96(&token.input_96_bits_hex).expect("valid token provenance hex");
        assert_eq!(encode_base32_96(&input), token.recognition_token);
        let decoded = decode_base32_96(&token.recognition_token).expect("canonical token");
        assert_eq!(decoded, input);
        assert_eq!(encode_base32_96(&decoded), token.recognition_token);
        assert!(token_inputs
            .insert(token.recognition_token.as_str(), input)
            .is_none());
    }

    let mut priorities = BTreeSet::new();
    let mut row_ids = BTreeSet::new();
    for row in &fixture.precedence_table {
        assert!(
            priorities.insert(row.priority),
            "duplicate priority {}",
            row.priority
        );
        assert!(
            row_ids.insert(row.row_id.as_str()),
            "duplicate row {}",
            row.row_id
        );
        assert!(matches!(
            row.expected_variant.as_str(),
            "REDEEMED" | "UNRECOGNIZED" | "REFUSED" | "lineage_corrupt"
        ));
    }
    assert_eq!(fixture.precedence_table.len(), 21);

    let mut vector_ids = BTreeSet::new();
    let mut positive_edge = None;
    for vector in &fixture.vectors {
        assert!(
            vector_ids.insert(vector.id.as_str()),
            "duplicate vector {}",
            vector.id
        );
        assert!(!vector.name.is_empty());
        if let (Some(request_bytes), Some(expected_bytes)) = (
            vector.request_bytes_base64.as_deref(),
            vector.expected_bytes_base64.as_deref(),
        ) {
            let request_wire = decode_base64(request_bytes);
            let expected_wire = decode_base64(expected_bytes);
            assert_eq!(
                serde_json::from_slice::<Value>(&request_wire).expect("exact request JSON"),
                vector.request,
                "{} exact request bytes",
                vector.id
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&expected_wire).expect("exact response JSON"),
                vector.expected,
                "{} exact response bytes",
                vector.id
            );
        } else {
            assert!(
                vector.request_bytes_base64.is_none() && vector.expected_bytes_base64.is_none(),
                "{} must pin both request and response bytes together",
                vector.id
            );
        }
        let request: LineageRequest = serde_json::from_value(vector.request.clone())
            .unwrap_or_else(|error| {
                panic!(
                    "{} request does not follow pinned encoding: {error}",
                    vector.id
                )
            });
        let response: LineageResponse = serde_json::from_value(vector.expected.clone())
            .unwrap_or_else(|error| {
                panic!(
                    "{} expected result does not follow pinned encoding: {error}",
                    vector.id
                )
            });
        let LineageRequest::Redeem {
            predecessor_key,
            agent,
            incarnation,
            observation,
            candidate,
        } = request;
        assert_eq!(predecessor_key, "session-predecessor-0001");
        assert_eq!(agent, "agent-main");
        assert_eq!(incarnation, 7);
        assert_source_and_token_provenance(vector, &observation, &token_inputs);

        let cell = PreconditionCell {
            scope_state: vector.scope_state.wire_name().to_string(),
            observation_class: observation_class(&observation, &fixture.sealed_scope).to_string(),
            candidate: candidate_class(
                vector.scope_state,
                &observation,
                candidate.as_ref(),
                &fixture.sealed_scope,
            )
            .to_string(),
            delivery_evidence: delivery_evidence(&observation).to_string(),
            metadata: metadata_class(&observation).to_string(),
            candidate_scope: candidate_scope_class(&vector.candidate_scope)
                .unwrap_or_else(|error| panic!("{} candidate scope facts: {error}", vector.id))
                .to_string(),
        };
        let selected = fixture
            .precedence_table
            .iter()
            .filter(|row| row_matches(row, &cell))
            .collect::<Vec<_>>();
        assert_eq!(
            selected.len(),
            1,
            "{} must have exactly one table-driven row for {cell:?}",
            vector.id
        );
        let selected = selected[0];
        assert_eq!(
            selected.row_id, vector.precedence_row,
            "{} precedence_row",
            vector.id
        );

        let LineageResponse::Redeem { result } = response;
        let signature = outcome_signature(&result);
        assert_eq!(
            signature.variant, selected.expected_variant,
            "{} owner-authored expected variant disagrees with precedence row {}",
            vector.id, selected.row_id
        );
        assert_eq!(
            signature.reason_or_cause,
            selected.expected_reason_or_cause.as_deref(),
            "{} owner-authored expected reason/cause disagrees with precedence row {}",
            vector.id,
            selected.row_id
        );
        if let RedeemResult::Redeemed {
            edge,
            existing,
            fence_generation,
            ..
        } = result
        {
            assert_eq!(*edge, fixture.sealed_scope.stored_edge);
            assert_eq!(fence_generation, fixture.sealed_scope.fence_generation);
            if existing {
                assert_eq!(
                    positive_edge.as_ref(),
                    Some(&edge),
                    "replay edge changed bytes"
                );
            } else {
                positive_edge = Some(edge);
            }
        }
    }
    assert_eq!(fixture.vectors.len(), 43);

    assert_eq!(fixture.legacy_expected_bytes.len(), 20);
    for (index, pinned) in fixture.legacy_expected_bytes.iter().enumerate() {
        let expected_id = format!("V{:02}", index + 1);
        assert_eq!(pinned.vector_id, expected_id);
        let vector = fixture
            .vectors
            .iter()
            .find(|vector| vector.id == pinned.vector_id)
            .expect("legacy vector");
        let pinned_bytes = decode_base64(&pinned.bytes_base64);
        assert_eq!(
            sha256_hex(&pinned_bytes),
            LEGACY_EXPECTED_SHA256[index],
            "{} pre-R47 expected bytes changed",
            pinned.vector_id
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&pinned_bytes).expect("legacy expected JSON"),
            vector.expected,
            "{} expected envelope no longer matches its pinned bytes",
            pinned.vector_id
        );
    }

    let index: Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    assert_immutable_specimen_files(&index);
    let redeem_entry = index["files"]
        .as_array()
        .expect("index files array")
        .iter()
        .find(|entry| entry["path"] == "redeem-vectors-v1.json")
        .expect("redeem vectors are indexed");
    assert_eq!(redeem_entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(redeem_entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(redeem_entry["derived"], false);
    assert_eq!(
        redeem_entry["source"],
        "owner-authored D5 redeem contract vectors"
    );
}
