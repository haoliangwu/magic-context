//! Executable reference model for the D5 scope, admission-fence and occupancy
//! rules that the R47 sequence vectors exercise.
//!
//! The sequence half of `redeem-vectors-v1.json` used to be "verified" by
//! decoding the fixture's own expected bytes and asserting literals inside them.
//! That check shares its source with the thing it checks: it cannot fail when
//! the rule is wrong, only when the author mistypes a number. This module
//! supplies the missing subject. It is an in-memory store whose operations
//! return the contract's own result types, so the oracle can run a transition
//! and compare the bytes the model produces against expectations that were
//! written independently of it.
//!
//! What the model covers: scope rows keyed by (owner, agent) carrying
//! incarnation, resolve_generation, lineage id and the four occupancy counts of
//! R47c; admission tickets as gateway-local samples that write nothing; redeem
//! with the R16 precondition order plus the R47/R47a candidate-scope condition
//! and its placeholder adoption; the generation fence on prepare,
//! lineage.begin and attempt.resolve; and the scope-keyed capacity upload
//! family, which R47c keeps out of both occupancy and the generation fence.
//!
//! Where the model deliberately stops, because modelling further would mean
//! inventing data nobody can check:
//!
//! * It never seals. A prepare whose ticket passes the fence returns
//!   `PrepareOutcome::Admitted` instead of a fabricated `ReceiptV1`, and
//!   `AttemptOutcome` therefore carries only the REFUSED arm the model can
//!   construct. The contract's SEALED, REDEEMED and RELEASED arms belong to the
//!   seal path, which no R47 vector reaches.
//! * `capacity.check` decides authorization and consumption only. The token
//!   estimate a CHECKED result carries needs the MC tokenizer, and that algebra
//!   is pinned by `capacity-estimate-vectors-v1.json`, not here.
//!
//! Both bounds are declared in the fixture on the steps that reach them, so a
//! reader of the vectors sees them without reading this file.
//!
//! The module carries its own small base64 decoder and its own copies of the
//! shared wire types on purpose: it must be checkable on its own, without
//! borrowing anything from the oracle that judges it.

// The module mirrors the contract's request and result shapes, including fields
// the fence model itself never reads (a request argument is part of the wire
// shape whether or not this model consults it).
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

// ---------------------------------------------------------------------------
// Shared wire types (contract clause 2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialFingerprint {
    pub digest: String,
    pub normalization_version: u64,
    pub excluded_additions: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionTicket {
    pub resolve_generation: u64,
    #[serde(rename = "P")]
    pub predecessor_key: String,
    pub agent: String,
    pub incarnation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptKey {
    pub predecessor_key: String,
    pub agent: String,
    #[serde(rename = "F")]
    pub fingerprint: MaterialFingerprint,
    pub attempt_id: String,
    pub incarnation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockIdentity {
    pub mid: String,
    pub index: u64,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecognitionIdentity {
    pub receipt_id: String,
    pub recognition_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuccessorCandidate {
    pub successor_key: String,
    pub native_continuation_identity: BlockIdentity,
    pub continuation_identity: RecognitionIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineageEdge {
    pub edge_id: String,
    pub predecessor_key: String,
    pub successor_key: String,
    pub agent: String,
    #[serde(rename = "F")]
    pub fingerprint: MaterialFingerprint,
    pub lineage_id: String,
    pub continuation_identity: RecognitionIdentity,
    pub native_continuation_identity: BlockIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Text,
    Reasoning,
    RedactedReasoning,
    ToolUse,
    ToolResult,
    Image,
    Document,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScanSource {
    DirectScalar,
    TextBlock,
    ToolResult,
    NoCandidateBlock,
    Other { source: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ObservedMarker {
    Valid { identity: RecognitionIdentity },
    Malformed { token_prefix: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecognitionObservation {
    pub scanned_identity: Option<BlockIdentity>,
    pub scanned_bytes_sha256: Option<String>,
    pub scanned_role: Option<Role>,
    pub scanned_kind: Option<BlockKind>,
    pub native_user_index: Option<u64>,
    pub scan_source: ScanSource,
    pub observed_markers: Vec<ObservedMarker>,
    pub may_have_replied: bool,
    pub ack: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
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
    UploadConflict,
    ChunkConflict,
    UploadDigestMismatch,
    UploadIncomplete,
    UploadQuota,
    D5ReceiptRequired,
    D5DowngradeRefused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RefusalDetails {
    None,
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
    Winner {
        receipt_id: String,
    },
    Live {
        upload_id: String,
        digest: String,
    },
    ResolvedAbsent {
        attempt_id: String,
        incarnation: u64,
    },
    Upload {
        upload_id: Option<String>,
        seq: Option<u64>,
        declared_digest: Option<String>,
        actual_digest: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub reason: RefusalReason,
    /// R19 keeps an absent Option inside a typed DTO as explicit null, which is
    /// what every merged D5 vector already carries.
    pub receipt_id: Option<String>,
    pub details: RefusalDetails,
}

/// R1 removed `current_resolve_generation`: the proof is fixed at the attempt's
/// own ticket so an identical replay stays identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NegativeProof {
    TombstoneRow {
        attempt_id: String,
        incarnation: u64,
    },
    GenerationFence {
        incarnation: u64,
        invalidated_ticket_generation: u64,
        fenced_by: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum PFence {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "SEALED")]
    Sealed { receipt_id: String },
    #[serde(rename = "REDEEMED")]
    Redeemed { successor_key: String },
}

/// Only the REFUSED arm is modelled; see the module header for why the seal arms
/// are out of bounds here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AttemptOutcome {
    #[serde(rename = "REFUSED")]
    Refused {
        refusal: Refusal,
        negative: NegativeProof,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadRef {
    pub upload_id: String,
    pub digest: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PrepareSource {
    Inline { segment: serde_json::Value },
    Ref { upload: UploadRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngressEvidence {
    pub boot_id: String,
    pub watermark: u64,
    pub sequence_seen: u64,
    pub ownership_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeometryV1 {
    pub usable_soft: u64,
    pub usable_hard: u64,
    pub absolute_wall: Option<u64>,
    pub derivation: String,
    pub reserve_accounting: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalProjectionIdentities {
    pub model: String,
    pub profile: String,
    pub tool_surface: String,
    pub guidance_surface: String,
    pub system_surface: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EnvelopeSlot {
    Available {
        record: serde_json::Value,
    },
    Absent {
        reason: String,
    },
    NewerUnusable {
        boot_id: String,
        sequence: u64,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareBudgetEvidence {
    pub schema_version: u64,
    pub geometry: GeometryV1,
    pub envelope: EnvelopeSlot,
    pub intended_normal_projection: NormalProjectionIdentities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceUploadKind {
    SourceSegment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckBody {
    Inline {
        bytes: String,
    },
    Upload {
        #[serde(rename = "ref")]
        reference: UploadRef,
    },
}

// ---------------------------------------------------------------------------
// Typed results (contract clause 2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ScopeResult {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum TicketResult {
    #[serde(rename = "ISSUED")]
    Issued { ticket: AdmissionTicket },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareResult {
    pub attempt_outcome: AttemptOutcome,
    pub p_fence: PFence,
    pub fence_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ResolveResult {
    #[serde(rename = "RESOLVED")]
    Resolved {
        attempt_outcome: Option<AttemptOutcome>,
        p_fence: PFence,
        fence_generation: u64,
        resolve_generation: u64,
    },
    #[serde(rename = "REFUSED")]
    Refused {
        refusal: Refusal,
        p_fence: PFence,
        fence_generation: u64,
        resolve_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum BeginResult {
    #[serde(rename = "BEGUN")]
    Begun { upload_id: String },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum PutResult {
    #[serde(rename = "STORED")]
    Stored { seq: u64, chunk_digest: String },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum FinishResult {
    #[serde(rename = "FINISHED")]
    Finished { upload: UploadRef },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

/// Only the REFUSED arm is modelled; a CHECKED estimate needs the tokenizer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CapacityResult {
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnrecognizedCause {
    NoCandidateBlock,
    NoMarker,
    MalformedMarker,
    DuplicateMarker,
    ForeignMarker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum RedeemResult {
    #[serde(rename = "REDEEMED")]
    Redeemed {
        receipt_id: String,
        edge: Box<LineageEdge>,
        existing: bool,
        fence_generation: u64,
        /// R47a(2) pins this as an operation-style option: omitted when None.
        #[serde(default, skip_serializing_if = "Option::is_none")]
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

/// A prepare whose ticket passes the arrival check. The model records the
/// attempt as occupancy and stops: sealing is the seal path's business.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareOutcome {
    Refused(PrepareResult),
    Admitted { attempt_id: String },
}

/// A check that resolves its staged upload consumes it (R43c). The estimate the
/// CHECKED result would carry is out of this model's bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapacityCheckOutcome {
    Authorized { upload: UploadRef },
    Refused(CapacityResult),
}

// ---------------------------------------------------------------------------
// Requests (contract clause 3, internally tagged by op)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum ModelRequest {
    #[serde(rename = "scope.open")]
    ScopeOpen {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
    },
    // R48: the nine original lineage operations are tagged on the wire by their
    // short names; `attempt.ticket` is the clause-3 label of this one.
    #[serde(rename = "ticket")]
    AttemptTicket {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
    },
    #[serde(rename = "redeem")]
    Redeem {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        observation: RecognitionObservation,
        candidate: Option<SuccessorCandidate>,
    },
    #[serde(rename = "prepare")]
    Prepare {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        #[serde(rename = "F")]
        fingerprint: MaterialFingerprint,
        source_segment: PrepareSource,
        attempt_id: String,
        incarnation: u64,
        admission_ticket: AdmissionTicket,
        ingress: IngressEvidence,
        budget: Box<PrepareBudgetEvidence>,
    },
    #[serde(rename = "resolve")]
    AttemptResolve {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        // Clause 3a omits an absent operation option. Rejecting a present null
        // is R43e's pinned check on capacity.begin and is not re-tested here.
        #[serde(default)]
        attempt_id: Option<String>,
        #[serde(default, rename = "F")]
        fingerprint: Option<MaterialFingerprint>,
        #[serde(default)]
        admission_ticket: Option<AdmissionTicket>,
    },
    #[serde(rename = "begin")]
    LineageBegin {
        attempt: AttemptKey,
        ticket: AdmissionTicket,
        kind: SourceUploadKind,
        total_bytes: u64,
        total_chunks: u64,
        digest: String,
    },
    #[serde(rename = "capacity.begin")]
    CapacityBegin {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        total_bytes: u64,
        total_chunks: u64,
        digest: String,
        #[serde(default)]
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
    #[serde(rename = "capacity.check")]
    CapacityCheck {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        body: CheckBody,
        model: String,
        geometry: GeometryV1,
    },
}

impl ModelRequest {
    /// Decode one request envelope from its wire bytes.
    ///
    /// The wire grammar carries the nine original lineage operations under short
    /// discriminators (`ticket`, `prepare`, `resolve`, `redeem`, `release`,
    /// `cancel`, `begin`, `put`, `finish`). The dotted `attempt.ticket`,
    /// `attempt.resolve` and `lineage.begin` spellings are operation LABELS and
    /// are refused on the wire, with no alias and no dual acceptance. The
    /// capacity family and `scope.open` were pinned with dotted discriminators
    /// and keep them. Ruling R48.
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice::<Self>(bytes).map_err(|error| {
            let reason = error.to_string();
            if reason.starts_with("unknown variant") {
                format!(
                    "{reason}; R48: the nine original lineage operations travel under their short \
                     wire discriminators, while capacity.* and scope.open keep the dotted \
                     discriminators they were pinned with"
                )
            } else {
                reason
            }
        })
    }

    /// The clause-3 operation LABEL this request carries. Step names in the
    /// fixture stay on this label. For the nine original operations the label
    /// and the wire discriminator differ: a request decoded from `{"op":"begin"}`
    /// is labelled `lineage.begin` (R48).
    pub fn op(&self) -> &'static str {
        match self {
            Self::ScopeOpen { .. } => "scope.open",
            Self::AttemptTicket { .. } => "attempt.ticket",
            Self::Redeem { .. } => "redeem",
            Self::Prepare { .. } => "prepare",
            Self::AttemptResolve { .. } => "attempt.resolve",
            Self::LineageBegin { .. } => "lineage.begin",
            Self::CapacityBegin { .. } => "capacity.begin",
            Self::CapacityPut { .. } => "capacity.put",
            Self::CapacityFinish { .. } => "capacity.finish",
            Self::CapacityCheck { .. } => "capacity.check",
        }
    }

    /// Outer key of the keyed response envelope this request produces.
    ///
    /// The nine original lineage operations use the same short discriminators on
    /// the response as on the request (`ticket`, `resolve`, `begin`). The
    /// clause-3 labels (`attempt.ticket`, `attempt.resolve`, `lineage.begin`)
    /// are not response keys. Capacity operations and `scope.open` keep the
    /// dotted names they were pinned with. No alias: a label is never also
    /// accepted as a key.
    pub fn response_wire_key(&self) -> &'static str {
        match self {
            Self::AttemptTicket { .. } => "ticket",
            Self::AttemptResolve { .. } => "resolve",
            Self::LineageBegin { .. } => "begin",
            other => other.op(),
        }
    }
}

/// Clause-3 labels that core `LineageResponse` does not accept as outer keys.
const REFUSED_RESPONSE_LABELS: &[&str] = &["attempt.ticket", "attempt.resolve", "lineage.begin"];

/// Build the keyed response envelope `{ "<wire_key>": { "result": <result> } }`.
pub fn keyed_response_bytes(wire_key: &str, result: &[u8]) -> Vec<u8> {
    format!(
        "{{\"{wire_key}\":{{\"result\":{}}}}}",
        String::from_utf8_lossy(result)
    )
    .into_bytes()
}

/// Decode a keyed response envelope against one expected wire key and result.
///
/// The outer key must be the short wire discriminator. A clause-3 label on the
/// envelope is refused even if the inner result bytes match, with no alias and
/// no dual acceptance.
pub fn decode_keyed_response(envelope: &[u8], wire_key: &str, result: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(envelope)
        .map_err(|error| format!("response is not JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "response envelope is not an object".to_string())?;
    if object.len() != 1 {
        return Err(format!(
            "response envelope must have exactly one outer key, got {}",
            object.len()
        ));
    }
    let key = object.keys().next().expect("len == 1").as_str();
    if REFUSED_RESPONSE_LABELS.contains(&key) {
        return Err(format!(
            "unknown variant `{key}`; clause-3 operation labels are not response keys"
        ));
    }
    if key != wire_key {
        return Err(format!("unknown variant `{key}`, expected `{wire_key}`"));
    }
    let expected = keyed_response_bytes(wire_key, result);
    if envelope != expected.as_slice() {
        return Err("keyed response envelope does not wrap this result".to_string());
    }
    Ok(())
}

/// What one executed step produced. `wire_result` is None exactly for the two
/// outcomes this model declines to invent a wire body for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    ScopeOpen(ScopeResult),
    Ticket(TicketResult),
    Redeem(RedeemResult),
    Prepare(PrepareOutcome),
    Resolve(ResolveResult),
    LineageBegin(BeginResult),
    CapacityBegin(BeginResult),
    CapacityPut(PutResult),
    CapacityFinish(FinishResult),
    CapacityCheck(CapacityCheckOutcome),
}

impl StepOutcome {
    pub fn wire_result(&self) -> Option<Vec<u8>> {
        fn encode<T: Serialize>(value: &T) -> Option<Vec<u8>> {
            Some(serde_json::to_vec(value).expect("model result serializes"))
        }
        match self {
            Self::ScopeOpen(result) => encode(result),
            Self::Ticket(result) => encode(result),
            Self::Redeem(result) => encode(result),
            Self::Resolve(result) => encode(result),
            Self::LineageBegin(result) | Self::CapacityBegin(result) => encode(result),
            Self::CapacityPut(result) => encode(result),
            Self::CapacityFinish(result) => encode(result),
            Self::Prepare(PrepareOutcome::Refused(result)) => encode(result),
            Self::CapacityCheck(CapacityCheckOutcome::Refused(result)) => encode(result),
            Self::Prepare(PrepareOutcome::Admitted { .. })
            | Self::CapacityCheck(CapacityCheckOutcome::Authorized { .. }) => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSeed {
    pub note: String,
    pub scopes: Vec<SeedScope>,
    pub receipts: Vec<SeedReceipt>,
    pub next_edge_id: String,
    pub next_source_upload_id: String,
    pub next_capacity_upload_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedScope {
    #[serde(rename = "P")]
    pub predecessor_key: String,
    pub agent: String,
    pub incarnation: u64,
    pub lineage_id: String,
    pub resolve_generation: u64,
    pub fence_generation: u64,
    pub source_uploads_live: u64,
    pub attempts_prepared_or_later: u64,
    pub in_edges: u64,
    pub out_edges: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedReceipt {
    pub receipt_id: String,
    pub predecessor_key: String,
    pub agent: String,
    pub incarnation: u64,
    pub lineage_id: String,
    pub state: ReceiptState,
    pub recognition_token: String,
    #[serde(rename = "F")]
    pub fingerprint: MaterialFingerprint,
    pub fence_generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReceiptState {
    #[serde(rename = "SEALED")]
    Sealed,
    #[serde(rename = "REDEEMED")]
    Redeemed,
    #[serde(rename = "REFUSED")]
    Refused,
    #[serde(rename = "RELEASED")]
    Released,
}

#[derive(Debug, Clone)]
struct ScopeRow {
    incarnation: u64,
    lineage_id: String,
    resolve_generation: u64,
    fence_generation: u64,
    source_uploads_live: u64,
    attempts_prepared_or_later: u64,
    in_edges: u64,
    out_edges: u64,
}

#[derive(Debug, Clone)]
struct Receipt {
    receipt_id: String,
    predecessor_key: String,
    agent: String,
    incarnation: u64,
    lineage_id: String,
    state: ReceiptState,
    recognition_token: String,
    fingerprint: MaterialFingerprint,
    fence_generation: u64,
    edge: Option<LineageEdge>,
}

#[derive(Debug, Clone)]
struct AttemptRow {
    predecessor_key: String,
    agent: String,
    ticket_generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadState {
    Open,
    Finished,
    Consumed,
}

/// The ownership a capacity upload is authorized under. R43c keys it on
/// (P, agent, incarnation) with no ticket and no generation, which is why an
/// upload staged before a placeholder adoption is still usable after it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CapacityAuthorization {
    predecessor_key: String,
    agent: String,
    incarnation: u64,
}

#[derive(Debug, Clone)]
struct CapacityUpload {
    authorization: CapacityAuthorization,
    declared_digest: String,
    total_bytes: u64,
    total_chunks: u64,
    chunks: BTreeMap<u64, Vec<u8>>,
    state: UploadState,
}

/// The scope-row facts a sequence step can assert. The fixture authors these
/// independently; the model produces them from its own store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeFacts {
    #[serde(rename = "P")]
    pub predecessor_key: String,
    pub agent: String,
    pub incarnation: u64,
    pub lineage_id: String,
    pub resolve_generation: u64,
    pub source_uploads_live: u64,
    pub attempts_prepared_or_later: u64,
    pub in_edges: u64,
    pub out_edges: u64,
    pub capacity_uploads_staged: u64,
    pub receipt_state: Option<ReceiptState>,
}

/// The three values that address a scope-keyed operation.
#[derive(Debug, Clone, Copy)]
struct ScopeAddress<'a> {
    predecessor_key: &'a str,
    agent: &'a str,
    incarnation: u64,
}

#[derive(Debug, Clone)]
pub struct ScopeModel {
    scopes: BTreeMap<(String, String), ScopeRow>,
    receipts: Vec<Receipt>,
    attempts: BTreeMap<String, AttemptRow>,
    capacity_uploads: BTreeMap<String, CapacityUpload>,
    source_uploads: BTreeMap<String, AttemptKey>,
    edges: Vec<LineageEdge>,
    next_edge_id: String,
    next_source_upload_id: String,
    next_capacity_upload_id: String,
}

impl ScopeModel {
    pub fn new(seed: &ModelSeed) -> Self {
        let mut scopes = BTreeMap::new();
        for scope in &seed.scopes {
            let key = (scope.predecessor_key.clone(), scope.agent.clone());
            let previous = scopes.insert(
                key,
                ScopeRow {
                    incarnation: scope.incarnation,
                    lineage_id: scope.lineage_id.clone(),
                    resolve_generation: scope.resolve_generation,
                    fence_generation: scope.fence_generation,
                    source_uploads_live: scope.source_uploads_live,
                    attempts_prepared_or_later: scope.attempts_prepared_or_later,
                    in_edges: scope.in_edges,
                    out_edges: scope.out_edges,
                },
            );
            assert!(previous.is_none(), "seed repeats a scope row");
        }
        let receipts = seed
            .receipts
            .iter()
            .map(|receipt| Receipt {
                receipt_id: receipt.receipt_id.clone(),
                predecessor_key: receipt.predecessor_key.clone(),
                agent: receipt.agent.clone(),
                incarnation: receipt.incarnation,
                lineage_id: receipt.lineage_id.clone(),
                state: receipt.state,
                recognition_token: receipt.recognition_token.clone(),
                fingerprint: receipt.fingerprint.clone(),
                fence_generation: receipt.fence_generation,
                edge: None,
            })
            .collect();
        Self {
            scopes,
            receipts,
            attempts: BTreeMap::new(),
            capacity_uploads: BTreeMap::new(),
            source_uploads: BTreeMap::new(),
            edges: Vec::new(),
            next_edge_id: seed.next_edge_id.clone(),
            next_source_upload_id: seed.next_source_upload_id.clone(),
            next_capacity_upload_id: seed.next_capacity_upload_id.clone(),
        }
    }

    pub fn run(&mut self, request: &ModelRequest) -> StepOutcome {
        match request {
            ModelRequest::ScopeOpen {
                predecessor_key,
                agent,
            } => StepOutcome::ScopeOpen(self.scope_open(predecessor_key, agent)),
            ModelRequest::AttemptTicket {
                predecessor_key,
                agent,
                incarnation,
            } => StepOutcome::Ticket(self.attempt_ticket(predecessor_key, agent, *incarnation)),
            ModelRequest::Redeem {
                predecessor_key,
                agent,
                incarnation,
                observation,
                candidate,
            } => StepOutcome::Redeem(self.redeem(
                predecessor_key,
                agent,
                *incarnation,
                observation,
                candidate.as_ref(),
            )),
            ModelRequest::Prepare {
                predecessor_key,
                agent,
                attempt_id,
                incarnation,
                admission_ticket,
                ..
            } => StepOutcome::Prepare(self.prepare(
                predecessor_key,
                agent,
                attempt_id,
                *incarnation,
                admission_ticket,
            )),
            ModelRequest::AttemptResolve {
                predecessor_key,
                agent,
                incarnation,
                attempt_id,
                fingerprint,
                admission_ticket,
            } => StepOutcome::Resolve(self.attempt_resolve(
                predecessor_key,
                agent,
                *incarnation,
                attempt_id.as_deref(),
                fingerprint.as_ref(),
                admission_ticket.as_ref(),
            )),
            ModelRequest::LineageBegin {
                attempt,
                ticket,
                total_bytes,
                total_chunks,
                digest,
                ..
            } => StepOutcome::LineageBegin(self.lineage_begin(
                attempt,
                ticket,
                *total_bytes,
                *total_chunks,
                digest,
            )),
            ModelRequest::CapacityBegin {
                predecessor_key,
                agent,
                incarnation,
                total_bytes,
                total_chunks,
                digest,
                expected_open,
            } => StepOutcome::CapacityBegin(self.capacity_begin(
                ScopeAddress {
                    predecessor_key,
                    agent,
                    incarnation: *incarnation,
                },
                *total_bytes,
                *total_chunks,
                digest,
                expected_open.as_deref(),
            )),
            ModelRequest::CapacityPut {
                upload_id,
                seq,
                bytes,
            } => StepOutcome::CapacityPut(self.capacity_put(upload_id, *seq, bytes)),
            ModelRequest::CapacityFinish { upload_id, digest } => {
                StepOutcome::CapacityFinish(self.capacity_finish(upload_id, digest))
            }
            ModelRequest::CapacityCheck {
                predecessor_key,
                agent,
                incarnation,
                body,
                ..
            } => StepOutcome::CapacityCheck(self.capacity_check(
                predecessor_key,
                agent,
                *incarnation,
                body,
            )),
        }
    }

    pub fn scope_facts(&self, predecessor_key: &str, agent: &str) -> Option<ScopeFacts> {
        let row = self
            .scopes
            .get(&(predecessor_key.to_string(), agent.to_string()))?;
        let staged = self
            .capacity_uploads
            .values()
            .filter(|upload| {
                upload.authorization.predecessor_key == predecessor_key
                    && upload.authorization.agent == agent
                    && upload.state != UploadState::Consumed
            })
            .count() as u64;
        Some(ScopeFacts {
            predecessor_key: predecessor_key.to_string(),
            agent: agent.to_string(),
            incarnation: row.incarnation,
            lineage_id: row.lineage_id.clone(),
            resolve_generation: row.resolve_generation,
            source_uploads_live: row.source_uploads_live,
            attempts_prepared_or_later: row.attempts_prepared_or_later,
            in_edges: row.in_edges,
            out_edges: row.out_edges,
            capacity_uploads_staged: staged,
            receipt_state: self
                .receipt_for(predecessor_key, agent)
                .map(|receipt| receipt.state),
        })
    }

    fn row(&self, predecessor_key: &str, agent: &str) -> Option<&ScopeRow> {
        self.scopes
            .get(&(predecessor_key.to_string(), agent.to_string()))
    }

    fn row_mut(&mut self, predecessor_key: &str, agent: &str) -> Option<&mut ScopeRow> {
        self.scopes
            .get_mut(&(predecessor_key.to_string(), agent.to_string()))
    }

    fn receipt_for(&self, predecessor_key: &str, agent: &str) -> Option<&Receipt> {
        self.receipts
            .iter()
            .find(|receipt| receipt.predecessor_key == predecessor_key && receipt.agent == agent)
    }

    // -- scope.open (clause 3b / R40) ---------------------------------------

    fn scope_open(&mut self, predecessor_key: &str, agent: &str) -> ScopeResult {
        if predecessor_key.is_empty() || agent.is_empty() {
            return ScopeResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::InvalidArguments,
                    receipt_id: None,
                    details: RefusalDetails::Field {
                        field: if predecessor_key.is_empty() {
                            "P"
                        } else {
                            "agent"
                        }
                        .to_string(),
                        reason: "required field is missing".to_string(),
                    },
                },
            };
        }
        match self.row(predecessor_key, agent) {
            // An existing row is returned unchanged, which is what makes a
            // scope.open racing an adoption observe one whole row or the other.
            Some(row) => ScopeResult::Opened {
                incarnation: row.incarnation,
                lineage_id: row.lineage_id.clone(),
                resolve_generation: row.resolve_generation,
                created: false,
            },
            None => panic!(
                "minting a fresh scope row for {predecessor_key}/{agent} is scope-open-vectors-v1.json's subject, not this model's"
            ),
        }
    }

    // -- attempt.ticket (clause 4 / R2 / R47b) ------------------------------

    fn attempt_ticket(&self, predecessor_key: &str, agent: &str, incarnation: u64) -> TicketResult {
        let row = self
            .row(predecessor_key, agent)
            .unwrap_or_else(|| panic!("ticket sampled before {predecessor_key} was opened"));
        assert_eq!(
            row.incarnation, incarnation,
            "a ticket sample against another incarnation is clause 15's subject, not this model's"
        );
        // The sample writes nothing: no issuance row, no generation change.
        TicketResult::Issued {
            ticket: AdmissionTicket {
                resolve_generation: row.resolve_generation,
                predecessor_key: predecessor_key.to_string(),
                agent: agent.to_string(),
                incarnation: row.incarnation,
            },
        }
    }

    // -- the admission fence (clause 4 / clause 8 / R1) ---------------------

    /// A ticket sampled before the row advanced its resolve_generation no longer
    /// admits work. The comparison is strictly less-than: a ticket sampled at
    /// the current generation is fresh and must pass.
    fn generation_fence(row: &ScopeRow, ticket: &AdmissionTicket) -> Option<NegativeProof> {
        if ticket.resolve_generation < row.resolve_generation {
            Some(NegativeProof::GenerationFence {
                incarnation: row.incarnation,
                invalidated_ticket_generation: ticket.resolve_generation,
                // R1 fixes the proof at the ticket, never at the current row, so
                // an unrelated attempt cannot change a replayed refusal.
                fenced_by: ticket.resolve_generation + 1,
            })
        } else {
            None
        }
    }

    fn fenced_refusal(attempt_id: &str, incarnation: u64) -> Refusal {
        Refusal {
            reason: RefusalReason::ResolvedAbsent,
            receipt_id: None,
            details: RefusalDetails::ResolvedAbsent {
                attempt_id: attempt_id.to_string(),
                incarnation,
            },
        }
    }

    fn p_fence(&self, predecessor_key: &str, agent: &str) -> PFence {
        match self.receipt_for(predecessor_key, agent) {
            Some(receipt) => match receipt.state {
                ReceiptState::Sealed => PFence::Sealed {
                    receipt_id: receipt.receipt_id.clone(),
                },
                ReceiptState::Redeemed => receipt
                    .edge
                    .as_ref()
                    .map(|edge| PFence::Redeemed {
                        successor_key: edge.successor_key.clone(),
                    })
                    .unwrap_or(PFence::None),
                ReceiptState::Refused | ReceiptState::Released => PFence::None,
            },
            None => PFence::None,
        }
    }

    // -- prepare (clause 3 / clause 4) --------------------------------------

    fn prepare(
        &mut self,
        predecessor_key: &str,
        agent: &str,
        attempt_id: &str,
        incarnation: u64,
        ticket: &AdmissionTicket,
    ) -> PrepareOutcome {
        let row = self
            .row(predecessor_key, agent)
            .unwrap_or_else(|| panic!("prepare against an unopened scope {predecessor_key}"))
            .clone();
        assert_eq!(
            row.incarnation, incarnation,
            "a stale incarnation is clause 15's subject, not this model's"
        );
        if let Some(negative) = Self::generation_fence(&row, ticket) {
            return PrepareOutcome::Refused(PrepareResult {
                attempt_outcome: AttemptOutcome::Refused {
                    refusal: Self::fenced_refusal(attempt_id, row.incarnation),
                    negative,
                },
                p_fence: self.p_fence(predecessor_key, agent),
                fence_generation: row.fence_generation,
            });
        }
        self.attempts.insert(
            attempt_id.to_string(),
            AttemptRow {
                predecessor_key: predecessor_key.to_string(),
                agent: agent.to_string(),
                ticket_generation: ticket.resolve_generation,
            },
        );
        if let Some(row) = self.row_mut(predecessor_key, agent) {
            row.attempts_prepared_or_later += 1;
        }
        PrepareOutcome::Admitted {
            attempt_id: attempt_id.to_string(),
        }
    }

    // -- attempt.resolve (clause 8 / R1) ------------------------------------

    fn attempt_resolve(
        &mut self,
        predecessor_key: &str,
        agent: &str,
        incarnation: u64,
        attempt_id: Option<&str>,
        fingerprint: Option<&MaterialFingerprint>,
        ticket: Option<&AdmissionTicket>,
    ) -> ResolveResult {
        let row = self
            .row(predecessor_key, agent)
            .unwrap_or_else(|| panic!("resolve against an unopened scope {predecessor_key}"))
            .clone();
        assert_eq!(
            row.incarnation, incarnation,
            "a stale incarnation is clause 15's subject, not this model's"
        );
        let p_fence = self.p_fence(predecessor_key, agent);
        let present = [
            attempt_id.is_some(),
            fingerprint.is_some(),
            ticket.is_some(),
        ];
        if present.iter().all(|value| !value) {
            // The restart read: a write-free snapshot of the fence.
            return ResolveResult::Resolved {
                attempt_outcome: None,
                p_fence,
                fence_generation: row.fence_generation,
                resolve_generation: row.resolve_generation,
            };
        }
        if !present.iter().all(|value| *value) {
            return ResolveResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::InvalidArguments,
                    receipt_id: None,
                    details: RefusalDetails::Field {
                        field: "attempt_id".to_string(),
                        reason: "attempt identity, F and ticket are supplied together".to_string(),
                    },
                },
                p_fence,
                fence_generation: row.fence_generation,
                resolve_generation: row.resolve_generation,
            };
        }
        let attempt_id = attempt_id.expect("closing resolve names its attempt");
        let ticket = ticket.expect("closing resolve carries the original ticket");
        assert!(
            !self.attempts.contains_key(attempt_id),
            "resolving an admitted attempt needs the seal path, which this model does not carry"
        );
        match Self::generation_fence(&row, ticket) {
            // Clause 8: the rowless refusal is authoritative and terminal, and
            // it carries the proof reconstructed from the original ticket. R1
            // keeps the replay identical, so the generation is not bumped again.
            Some(negative) => ResolveResult::Resolved {
                attempt_outcome: Some(AttemptOutcome::Refused {
                    refusal: Self::fenced_refusal(attempt_id, row.incarnation),
                    negative,
                }),
                p_fence,
                fence_generation: row.fence_generation,
                resolve_generation: row.resolve_generation,
            },
            None => panic!(
                "resolving a still-admissible attempt needs the tombstone path, which this model does not carry"
            ),
        }
    }

    // -- lineage.begin (R11 / R47c) -----------------------------------------

    fn lineage_begin(
        &mut self,
        attempt: &AttemptKey,
        ticket: &AdmissionTicket,
        total_bytes: u64,
        _total_chunks: u64,
        digest: &str,
    ) -> BeginResult {
        let row = self
            .row(&attempt.predecessor_key, &attempt.agent)
            .unwrap_or_else(|| panic!("upload against an unopened scope"))
            .clone();
        assert_eq!(
            row.incarnation, attempt.incarnation,
            "a stale incarnation is clause 15's subject, not this model's"
        );
        // The source-segment upload carries the attempt's admission ticket, so
        // the same arrival check applies to it as to prepare. BeginResult has no
        // place for a negative proof, so it refuses plainly and the gateway
        // reads the proof from prepare or attempt.resolve.
        if Self::generation_fence(&row, ticket).is_some() {
            return BeginResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::TicketInvalid,
                    receipt_id: None,
                    details: RefusalDetails::Field {
                        field: "ticket".to_string(),
                        reason: "admission ticket generation is no longer current".to_string(),
                    },
                },
            };
        }
        let upload_id = self.next_source_upload_id.clone();
        assert!(
            self.source_uploads
                .insert(upload_id.clone(), attempt.clone())
                .is_none(),
            "the model mints one source upload id"
        );
        if let Some(row) = self.row_mut(&attempt.predecessor_key, &attempt.agent) {
            // A live source-segment upload is an attempt in flight: occupancy.
            row.source_uploads_live += 1;
        }
        let _ = (total_bytes, digest);
        BeginResult::Begun { upload_id }
    }

    // -- capacity uploads (R43a / R43b / R43c / R47c) -----------------------

    fn capacity_begin(
        &mut self,
        scope: ScopeAddress<'_>,
        total_bytes: u64,
        total_chunks: u64,
        digest: &str,
        expected_open: Option<&str>,
    ) -> BeginResult {
        let ScopeAddress {
            predecessor_key,
            agent,
            incarnation,
        } = scope;
        let row = self
            .row(predecessor_key, agent)
            .unwrap_or_else(|| panic!("capacity upload against an unopened scope"))
            .clone();
        assert_eq!(
            row.incarnation, incarnation,
            "a stale incarnation is clause 15's subject, not this model's"
        );
        let live = self.capacity_uploads.iter().find(|(_, upload)| {
            upload.authorization.predecessor_key == predecessor_key
                && upload.authorization.agent == agent
                && upload.state != UploadState::Consumed
        });
        if let Some((upload_id, upload)) = live {
            if expected_open != Some(upload_id.as_str()) {
                return BeginResult::Refused {
                    refusal: Refusal {
                        reason: RefusalReason::UploadConflict,
                        receipt_id: None,
                        details: RefusalDetails::Live {
                            upload_id: upload_id.clone(),
                            digest: upload.declared_digest.clone(),
                        },
                    },
                };
            }
        }
        let upload_id = self.next_capacity_upload_id.clone();
        self.capacity_uploads.insert(
            upload_id.clone(),
            CapacityUpload {
                // No ticket and no generation: the staging is authorized by the
                // scope alone, which is why a placeholder adoption cannot strand
                // it.
                authorization: CapacityAuthorization {
                    predecessor_key: predecessor_key.to_string(),
                    agent: agent.to_string(),
                    incarnation,
                },
                declared_digest: digest.to_string(),
                total_bytes,
                total_chunks,
                chunks: BTreeMap::new(),
                state: UploadState::Open,
            },
        );
        BeginResult::Begun { upload_id }
    }

    fn capacity_authorized(&self, upload: &CapacityUpload) -> bool {
        let Some(row) = self.row(
            &upload.authorization.predecessor_key,
            &upload.authorization.agent,
        ) else {
            return false;
        };
        upload.authorization.incarnation == row.incarnation
    }

    fn unauthorized_upload_refusal(upload_id: &str) -> Refusal {
        Refusal {
            reason: RefusalReason::InvalidArguments,
            receipt_id: None,
            details: RefusalDetails::Upload {
                upload_id: Some(upload_id.to_string()),
                seq: None,
                declared_digest: None,
                actual_digest: None,
            },
        }
    }

    fn capacity_put(&mut self, upload_id: &str, seq: u64, bytes: &str) -> PutResult {
        let Some(upload) = self.capacity_uploads.get(upload_id) else {
            return PutResult::Refused {
                refusal: Self::unauthorized_upload_refusal(upload_id),
            };
        };
        if upload.state != UploadState::Open || !self.capacity_authorized(upload) {
            return PutResult::Refused {
                refusal: Self::unauthorized_upload_refusal(upload_id),
            };
        }
        let chunk = decode_base64(bytes);
        let chunk_digest = sha256_hex(&chunk);
        let upload = self
            .capacity_uploads
            .get_mut(upload_id)
            .expect("upload is present");
        upload.chunks.insert(seq, chunk);
        PutResult::Stored { seq, chunk_digest }
    }

    fn capacity_finish(&mut self, upload_id: &str, digest: &str) -> FinishResult {
        let Some(upload) = self.capacity_uploads.get(upload_id) else {
            return FinishResult::Refused {
                refusal: Self::unauthorized_upload_refusal(upload_id),
            };
        };
        if upload.state != UploadState::Open || !self.capacity_authorized(upload) {
            return FinishResult::Refused {
                refusal: Self::unauthorized_upload_refusal(upload_id),
            };
        }
        if upload.chunks.len() as u64 != upload.total_chunks {
            return FinishResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::UploadIncomplete,
                    receipt_id: None,
                    details: RefusalDetails::Upload {
                        upload_id: Some(upload_id.to_string()),
                        seq: None,
                        declared_digest: Some(upload.declared_digest.clone()),
                        actual_digest: None,
                    },
                },
            };
        }
        let ordered: Vec<u8> = upload
            .chunks
            .values()
            .flat_map(|chunk| chunk.iter().copied())
            .collect();
        let actual = sha256_hex(&ordered);
        if actual != digest || actual != upload.declared_digest {
            return FinishResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::UploadDigestMismatch,
                    receipt_id: None,
                    details: RefusalDetails::Upload {
                        upload_id: Some(upload_id.to_string()),
                        seq: None,
                        declared_digest: Some(digest.to_string()),
                        actual_digest: Some(actual),
                    },
                },
            };
        }
        let total_bytes = ordered.len() as u64;
        let upload = self
            .capacity_uploads
            .get_mut(upload_id)
            .expect("upload is present");
        upload.state = UploadState::Finished;
        FinishResult::Finished {
            upload: UploadRef {
                upload_id: upload_id.to_string(),
                digest: actual,
                total_bytes,
            },
        }
    }

    fn capacity_check(
        &mut self,
        predecessor_key: &str,
        agent: &str,
        incarnation: u64,
        body: &CheckBody,
    ) -> CapacityCheckOutcome {
        let CheckBody::Upload { reference } = body else {
            panic!("an inline check body is capacity-estimate-vectors-v1.json's subject")
        };
        let authorization = CapacityAuthorization {
            predecessor_key: predecessor_key.to_string(),
            agent: agent.to_string(),
            incarnation,
        };
        let usable = self
            .capacity_uploads
            .get(&reference.upload_id)
            .filter(|upload| upload.state == UploadState::Finished)
            .filter(|upload| upload.authorization == authorization)
            .filter(|upload| self.capacity_authorized(upload))
            .filter(|upload| upload.declared_digest == reference.digest)
            .is_some();
        if !usable {
            return CapacityCheckOutcome::Refused(CapacityResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::InvalidArguments,
                    receipt_id: None,
                    details: RefusalDetails::Field {
                        field: "ref".to_string(),
                        reason: "re_upload_required".to_string(),
                    },
                },
            });
        }
        // The first check consumes the staged bytes.
        let upload = self
            .capacity_uploads
            .get_mut(&reference.upload_id)
            .expect("upload is present");
        upload.state = UploadState::Consumed;
        upload.chunks.clear();
        CapacityCheckOutcome::Authorized {
            upload: reference.clone(),
        }
    }

    // -- redeem (clause 10 / R16 / R47 / R47a) ------------------------------

    fn redeem(
        &mut self,
        predecessor_key: &str,
        agent: &str,
        incarnation: u64,
        observation: &RecognitionObservation,
        candidate: Option<&SuccessorCandidate>,
    ) -> RedeemResult {
        let receipt = self
            .receipt_for(predecessor_key, agent)
            .filter(|receipt| receipt.incarnation == incarnation)
            .cloned();

        // 1. Scope state. An absent, refused or released scope resolves absent
        //    before anything else is read.
        let Some(receipt) = receipt.filter(|receipt| {
            matches!(receipt.state, ReceiptState::Sealed | ReceiptState::Redeemed)
        }) else {
            return RedeemResult::Refused {
                refusal: Refusal {
                    reason: RefusalReason::ResolvedAbsent,
                    receipt_id: None,
                    details: RefusalDetails::ResolvedAbsent {
                        attempt_id: "redeem-scope-lookup".to_string(),
                        incarnation,
                    },
                },
            };
        };
        let redeemed = receipt.state == ReceiptState::Redeemed;
        let already_redeemed = || RedeemResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::AlreadyRedeemed,
                receipt_id: Some(receipt.receipt_id.clone()),
                details: RefusalDetails::Winner {
                    receipt_id: receipt.receipt_id.clone(),
                },
            },
        };
        let sealed_invalid = |field: &str, reason: &str| RedeemResult::Refused {
            refusal: Refusal {
                reason: RefusalReason::InvalidArguments,
                receipt_id: Some(receipt.receipt_id.clone()),
                details: RefusalDetails::Field {
                    field: field.to_string(),
                    reason: reason.to_string(),
                },
            },
        };

        // 2. Delivery evidence.
        if !observation.may_have_replied && observation.ack.is_none() {
            return if redeemed {
                already_redeemed()
            } else {
                sealed_invalid(
                    "observation.delivery_evidence",
                    "may_have_replied is false and ack is absent",
                )
            };
        }

        // 3. Metadata consistency.
        if !metadata_consistent(observation) {
            return if redeemed {
                already_redeemed()
            } else {
                sealed_invalid("observation", "recognition metadata is inconsistent")
            };
        }

        // 4. Marker and token classification.
        let class = observation_class(observation, &receipt);
        if redeemed {
            if class != ObservationClass::SingleValidStoredMarker {
                return already_redeemed();
            }
        } else {
            match class {
                ObservationClass::NoCandidateBlock
                | ObservationClass::NoMarker
                | ObservationClass::Malformed
                | ObservationClass::DuplicateValid
                | ObservationClass::ForeignReceipt => {
                    return if candidate.is_some() {
                        sealed_invalid(
                            "candidate",
                            "candidate requires one valid marker for the sealed receipt",
                        )
                    } else {
                        RedeemResult::Unrecognized {
                            receipt_id: receipt.receipt_id.clone(),
                            cause: class.cause(),
                        }
                    };
                }
                ObservationClass::MatchingReceiptWrongToken => {
                    return RedeemResult::Refused {
                        refusal: Refusal {
                            reason: RefusalReason::SealMaterialMismatch,
                            receipt_id: Some(receipt.receipt_id.clone()),
                            details: RefusalDetails::Field {
                                field: "recognition_token".to_string(),
                                reason: "marker token is not the sealed recognition token"
                                    .to_string(),
                            },
                        },
                    };
                }
                ObservationClass::SingleValidStoredMarker => {}
            }
        }

        // 5. Candidate relation.
        let Some(candidate) = candidate else {
            return if redeemed {
                already_redeemed()
            } else {
                sealed_invalid("candidate", "recognition requires the successor candidate")
            };
        };
        if redeemed {
            let stored = receipt
                .edge
                .as_ref()
                .expect("a redeemed receipt holds its edge");
            let replay = candidate.continuation_identity == stored.continuation_identity
                && candidate.native_continuation_identity == stored.native_continuation_identity
                && candidate.successor_key == stored.successor_key;
            return if replay {
                RedeemResult::Redeemed {
                    receipt_id: receipt.receipt_id.clone(),
                    edge: Box::new(stored.clone()),
                    existing: true,
                    fence_generation: receipt.fence_generation,
                    // A replay adopts nothing, so the field stays absent even
                    // when the first redemption reported an adoption.
                    lineage_adopted_from: None,
                }
            } else {
                already_redeemed()
            };
        }
        let observed = observation
            .observed_markers
            .iter()
            .find_map(|marker| match marker {
                ObservedMarker::Valid { identity } => Some(identity),
                ObservedMarker::Malformed { .. } => None,
            })
            .expect("a single valid marker was classified above");
        if candidate.continuation_identity != *observed {
            return sealed_invalid(
                "candidate.continuation_identity",
                "candidate identity is not the observed marker identity",
            );
        }
        if observation.scanned_identity.as_ref() != Some(&candidate.native_continuation_identity) {
            return sealed_invalid(
                "candidate.native_continuation_identity",
                "candidate block identity is not the scanned identity",
            );
        }

        // 6. Candidate scope (R47), evaluated last and before the write.
        let successor_row = self.row(&candidate.successor_key, agent).cloned();
        let mut adopted_from = None;
        if let Some(row) = &successor_row {
            let occupied = row.source_uploads_live > 0
                || row.attempts_prepared_or_later > 0
                || row.in_edges > 0
                || row.out_edges > 0;
            if occupied {
                return sealed_invalid(
                    "candidate",
                    "candidate scope has its own attempts or descent",
                );
            }
            if row.lineage_id != receipt.lineage_id {
                adopted_from = Some(row.lineage_id.clone());
            }
        }

        // The write. Adoption rebinds the placeholder row and advances its
        // generation in the same transaction, under a CAS on the two values the
        // row was read at.
        let edge = LineageEdge {
            edge_id: self.next_edge_id.clone(),
            predecessor_key: predecessor_key.to_string(),
            successor_key: candidate.successor_key.clone(),
            agent: agent.to_string(),
            fingerprint: receipt.fingerprint.clone(),
            lineage_id: receipt.lineage_id.clone(),
            continuation_identity: RecognitionIdentity {
                receipt_id: receipt.receipt_id.clone(),
                recognition_token: receipt.recognition_token.clone(),
            },
            native_continuation_identity: candidate.native_continuation_identity.clone(),
        };
        if let Some(read) = successor_row {
            let current = self
                .row(&candidate.successor_key, agent)
                .expect("the successor row was read above");
            if current.incarnation != read.incarnation
                || current.resolve_generation != read.resolve_generation
            {
                return sealed_invalid("candidate", "candidate scope row changed under the write");
            }
            let row = self
                .row_mut(&candidate.successor_key, agent)
                .expect("the successor row was read above");
            if adopted_from.is_some() {
                row.lineage_id = edge.lineage_id.clone();
                // R47a(3) / R47b: the advance is what fences every ticket that
                // was sampled against the placeholder row.
                row.resolve_generation += 1;
            }
            row.in_edges += 1;
        }
        if let Some(row) = self.row_mut(predecessor_key, agent) {
            row.out_edges += 1;
        }
        let receipt_id = receipt.receipt_id.clone();
        let fence_generation = receipt.fence_generation;
        let stored = self
            .receipts
            .iter_mut()
            .find(|receipt| receipt.receipt_id == receipt_id)
            .expect("the receipt was read above");
        stored.state = ReceiptState::Redeemed;
        stored.edge = Some(edge.clone());
        self.edges.push(edge.clone());
        RedeemResult::Redeemed {
            receipt_id,
            edge: Box::new(edge),
            existing: false,
            fence_generation,
            lineage_adopted_from: adopted_from,
        }
    }
}

// ---------------------------------------------------------------------------
// Raw-fact classification (R16 / R47a)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObservationClass {
    NoCandidateBlock,
    NoMarker,
    Malformed,
    DuplicateValid,
    ForeignReceipt,
    MatchingReceiptWrongToken,
    SingleValidStoredMarker,
}

impl ObservationClass {
    fn cause(self) -> UnrecognizedCause {
        match self {
            Self::NoCandidateBlock => UnrecognizedCause::NoCandidateBlock,
            Self::NoMarker => UnrecognizedCause::NoMarker,
            Self::Malformed => UnrecognizedCause::MalformedMarker,
            Self::DuplicateValid => UnrecognizedCause::DuplicateMarker,
            Self::ForeignReceipt => UnrecognizedCause::ForeignMarker,
            Self::MatchingReceiptWrongToken | Self::SingleValidStoredMarker => {
                panic!("a recognized marker has no unrecognized cause")
            }
        }
    }
}

fn observation_class(observation: &RecognitionObservation, receipt: &Receipt) -> ObservationClass {
    if observation.scan_source == ScanSource::NoCandidateBlock {
        return ObservationClass::NoCandidateBlock;
    }
    if observation.observed_markers.is_empty() {
        return ObservationClass::NoMarker;
    }
    if observation
        .observed_markers
        .iter()
        .any(|marker| matches!(marker, ObservedMarker::Malformed { .. }))
    {
        return ObservationClass::Malformed;
    }
    let valid: Vec<&RecognitionIdentity> = observation
        .observed_markers
        .iter()
        .filter_map(|marker| match marker {
            ObservedMarker::Valid { identity } => Some(identity),
            ObservedMarker::Malformed { .. } => None,
        })
        .collect();
    if valid.len() != 1 {
        return ObservationClass::DuplicateValid;
    }
    if valid[0].receipt_id != receipt.receipt_id {
        return ObservationClass::ForeignReceipt;
    }
    if valid[0].recognition_token != receipt.recognition_token {
        return ObservationClass::MatchingReceiptWrongToken;
    }
    ObservationClass::SingleValidStoredMarker
}

fn metadata_consistent(observation: &RecognitionObservation) -> bool {
    match observation.scan_source {
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
    }
}

// ---------------------------------------------------------------------------
// Local helpers (kept here so the model shares no code with the test that judges it)
// ---------------------------------------------------------------------------

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
    for chunk in encoded.as_bytes().chunks(4) {
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
