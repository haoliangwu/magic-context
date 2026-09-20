use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_NAME: &str = "d5-inherited-transfer-vectors-v1.json";
const INDEX_SOURCE: &str = "owner-authored D5 inherited-member transfer vectors";
const PROOF_MISMATCH: &str = "d5_carry_proof_mismatch";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    contract_version: String,
    ruling_tip: String,
    specimen_class: SpecimenClass,
    predicate_rule: PredicateRule,
    twice_inherited_ordinal_resolution: OrdinalResolution,
    vectors: Vec<Vector>,
    unit_locator_controls: Vec<UnitLocatorControl>,
    generation: Generation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecimenClass {
    classification: String,
    payload_note: String,
    algebra_payload_example: String,
    canonical_text_block_example: String,
    presence_note: String,
    establishes: Vec<String>,
    does_not_establish: Vec<String>,
    follow_up: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PredicateRule {
    unit_validation_order: String,
    member_join: String,
    must_match: Vec<String>,
    may_change: Vec<String>,
    forbidden: Vec<String>,
    digest_domains: String,
    unit_locator_rule: String,
    refusal_transport: String,
    expectations: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrdinalResolution {
    status: String,
    source_space: String,
    vector_id: String,
    source_ordinal: u64,
    m2_immediate_predecessor: String,
    preserved_predecessor_identity: BlockIdentity,
    decision: String,
    citations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    fixture_kind: String,
    index_source: String,
    generation_script: String,
    digest_values: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    origin_receipt_id: String,
    lineage: Lineage,
    member_presence: ConstructedPresence,
    held_m1: ManifestMember,
    successor_m2: ManifestMember,
    source_derivation: MemberDerivations,
    served_derivation: MemberDerivations,
    unit_evidence: Vec<UnitEvidence>,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lineage {
    source_session: String,
    serving_session_m1: String,
    serving_session_m2: String,
    m2_immediate_predecessor: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestMember {
    message: ManifestMessage,
    block: ManifestBlock,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestMessage {
    ordinal: u64,
    native_mid: String,
    native_position: Option<u64>,
    role: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestBlock {
    index: u64,
    kind: String,
    predecessor_identity: BlockIdentity,
    provenance: Provenance,
    source: MaterialDigest,
    served: MaterialDigest,
    applied_unit: Option<String>,
    tool_links: Vec<ToolArc>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BlockIdentity {
    mid: String,
    index: u64,
    ordinal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Provenance {
    Native {
        attempt_id: String,
        predecessor_key: String,
        message_position: u64,
    },
    InheritedFrom {
        receipt_id: String,
        origin_identity: BlockIdentity,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MaterialDigest {
    len: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolArc {
    tool_use_id: String,
    use_identity: Option<BlockIdentity>,
    result_identity: Option<BlockIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberDerivations {
    held_m1: DomainDerivation,
    successor_m2: DomainDerivation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DomainDerivation {
    tag: String,
    encoding_version: u32,
    bytes_base64: String,
    preimage_hex: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitEvidence {
    validation_scope: ValidationScope,
    member_side: MemberSide,
    row_version: u64,
    record: UnitRecordV1,
    projection: LocatedProjection,
    carrier: UnitCarrier,
    digest_derivation: UnitDigestDerivation,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ValidationScope {
    HeldM1,
    CurrentPass,
    PriorRecorded,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MemberSide {
    HeldM1,
    SuccessorM2,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitRecordV1 {
    unit: String,
    kind: UnitKind,
    coverage: Coverage,
    locator: Option<Locator>,
    sha256: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum UnitKind {
    Compartment { compartment_sequence: u64 },
    Reduction,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Coverage {
    start: u64,
    end: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Locator {
    mid: String,
    index: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocatedProjection {
    locator: Locator,
    bytes_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitCarrier {
    input_class: String,
    mid: String,
    role: String,
    ordinal: Option<u64>,
    synthetic: bool,
    /// How this carrier relates to the member's source message. DECLARED, never inferred:
    /// a different serving mid does not imply a different source, because R24a permits a
    /// fresh mid for the same source block with its ordinal unchanged.
    source_relation: CarrierSourceRelation,
    /// Why this carrier is stamped the way it is, for a reader who has only the file.
    #[serde(default)]
    carrier_note: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CarrierSourceRelation {
    /// The member's own message carries its committed unit.
    SameMessage,
    /// The same source block under a freshly allocated serving mid (R24a); the ordinal holds.
    SameSourceReallocated,
    /// A different source message entirely; it carries its own ordinal.
    IndependentSource,
    /// The MC-injected head (m0/m1): synthetic, with no source coordinate.
    SyntheticHead,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitLocatorControl {
    id: String,
    name: String,
    member: LocatorControlMember,
    member_presence: ConstructedPresence,
    row_version: u64,
    record: UnitRecordV1,
    projection: LocatedProjection,
    carrier: UnitCarrier,
    digest_derivation: LocatorDigestDerivation,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocatorControlMember {
    identity: Locator,
    role: String,
    ordinal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConstructedPresence {
    input_class: String,
    state: MemberPresence,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MemberPresence {
    Present,
    Absent,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocatorDigestDerivation {
    preimage_hex: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitDigestDerivation {
    bytes_base64: String,
    served: DigestProof,
    unit_projection: DigestProof,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DigestProof {
    tag: String,
    encoding_version: u32,
    preimage_hex: String,
    sha256: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Expected {
    outcome: ExpectedOutcome,
    http_status: Option<u16>,
    error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
enum ExpectedOutcome {
    #[serde(rename = "ACCEPT")]
    Accept,
    #[serde(rename = "REFUSE")]
    Refuse,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Accept,
    Refuse {
        http_status: u16,
        error_code: &'static str,
    },
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join(FIXTURE_NAME)).expect("read inherited fixture");
    let fixture = serde_json::from_slice(&bytes).expect("parse inherited fixture");
    (fixture, bytes)
}

fn vector<'a>(fixture: &'a Fixture, id: &str) -> &'a Vector {
    fixture
        .vectors
        .iter()
        .find(|vector| vector.id == id)
        .unwrap_or_else(|| panic!("missing inherited vector {id}"))
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
    assert_eq!(input.len() % 4, 0, "base64 quantum");
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

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend(value.to_be_bytes());
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend(value.to_be_bytes());
}

fn push_blob(output: &mut Vec<u8>, value: &[u8]) {
    push_u64(output, value.len() as u64);
    output.extend(value);
}

fn digest_preimage(tag: &str, payload: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    push_u32(&mut output, tag.len() as u32);
    output.extend(tag.as_bytes());
    push_u32(&mut output, 1);
    output.extend(payload);
    output
}

fn material_preimage(tag: &str, bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_blob(&mut payload, bytes);
    digest_preimage(tag, &payload)
}

fn unit_preimage(unit: &str, row_version: u64, bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_blob(&mut payload, unit.as_bytes());
    push_u64(&mut payload, row_version);
    push_blob(&mut payload, bytes);
    digest_preimage("mc.d5.unit-projection.v1", &payload)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn member_side(vector: &Vector, side: MemberSide) -> &ManifestMember {
    match side {
        MemberSide::HeldM1 => &vector.held_m1,
        MemberSide::SuccessorM2 => &vector.successor_m2,
    }
}

fn verify_domain_derivation(
    vector_id: &str,
    member: &ManifestMember,
    derivation: &DomainDerivation,
    tag: &str,
    field: &MaterialDigest,
) {
    let bytes = decode_base64(&derivation.bytes_base64);
    let preimage = material_preimage(tag, &bytes);
    assert_eq!(derivation.tag, tag, "{vector_id} digest tag");
    assert_eq!(derivation.encoding_version, 1, "{vector_id} version");
    assert_eq!(
        derivation.preimage_hex,
        hex(&preimage),
        "{vector_id} preimage"
    );
    assert_eq!(
        derivation.sha256,
        sha256_hex(&preimage),
        "{vector_id} digest"
    );
    assert_eq!(field.len, bytes.len() as u64, "{vector_id} member length");
    assert_eq!(field.sha256, derivation.sha256, "{vector_id} member digest");
    assert_eq!(member.message.role, "assistant");
}

fn verify_derivations(vector: &Vector) {
    verify_domain_derivation(
        &vector.id,
        &vector.held_m1,
        &vector.source_derivation.held_m1,
        "mc.d5.block.source.v1",
        &vector.held_m1.block.source,
    );
    verify_domain_derivation(
        &vector.id,
        &vector.successor_m2,
        &vector.source_derivation.successor_m2,
        "mc.d5.block.source.v1",
        &vector.successor_m2.block.source,
    );
    verify_domain_derivation(
        &vector.id,
        &vector.held_m1,
        &vector.served_derivation.held_m1,
        "mc.d5.block.served.v1",
        &vector.held_m1.block.served,
    );
    verify_domain_derivation(
        &vector.id,
        &vector.successor_m2,
        &vector.served_derivation.successor_m2,
        "mc.d5.block.served.v1",
        &vector.successor_m2.block.served,
    );

    for evidence in &vector.unit_evidence {
        let bytes = decode_base64(&evidence.projection.bytes_base64);
        let bound_member = member_side(vector, evidence.member_side);
        let served_preimage = material_preimage("mc.d5.block.served.v1", &bytes);
        let unit_preimage = unit_preimage(&evidence.record.unit, evidence.row_version, &bytes);
        assert_eq!(
            evidence.record.locator.as_ref(),
            Some(&evidence.projection.locator)
        );
        assert_eq!(
            evidence.digest_derivation.bytes_base64,
            evidence.projection.bytes_base64
        );
        assert_eq!(
            evidence.digest_derivation.served.tag,
            "mc.d5.block.served.v1"
        );
        assert_eq!(evidence.digest_derivation.served.encoding_version, 1);
        assert_eq!(
            evidence.digest_derivation.served.preimage_hex,
            hex(&served_preimage)
        );
        assert_eq!(
            evidence.digest_derivation.served.sha256,
            sha256_hex(&served_preimage)
        );
        assert_eq!(
            evidence.digest_derivation.unit_projection.tag,
            "mc.d5.unit-projection.v1"
        );
        assert_eq!(
            evidence.digest_derivation.unit_projection.encoding_version,
            1
        );
        assert_eq!(
            evidence.digest_derivation.unit_projection.preimage_hex,
            hex(&unit_preimage)
        );
        assert_eq!(
            evidence.digest_derivation.unit_projection.sha256,
            sha256_hex(&unit_preimage)
        );
        assert_eq!(
            evidence.record.sha256,
            evidence.digest_derivation.unit_projection.sha256
        );
        assert_ne!(
            evidence.digest_derivation.served.sha256,
            evidence.digest_derivation.unit_projection.sha256,
            "{} digest domains unexpectedly met",
            vector.id
        );
        assert_eq!(bound_member.block.served.len, bytes.len() as u64);
        assert_eq!(
            bound_member.block.served.sha256,
            evidence.digest_derivation.served.sha256
        );
    }
}

fn refuse() -> Verdict {
    Verdict::Refuse {
        http_status: 503,
        error_code: PROOF_MISMATCH,
    }
}

fn evidence_member<'a>(vector: &'a Vector, evidence: &UnitEvidence) -> &'a ManifestMember {
    match evidence.member_side {
        MemberSide::HeldM1 => &vector.held_m1,
        MemberSide::SuccessorM2 => &vector.successor_m2,
    }
}

fn carrier_names_locator(carrier: &UnitCarrier, locator: &Locator) -> bool {
    carrier.input_class == "CONSTRUCTED" && carrier.mid == locator.mid
}

fn present_reduction_evidence_is_structural(vector: &Vector, evidence: &UnitEvidence) -> bool {
    let Some(locator) = evidence.record.locator.as_ref() else {
        return false;
    };
    let member = evidence_member(vector, evidence);
    vector.member_presence.input_class == "CONSTRUCTED"
        && vector.member_presence.state == MemberPresence::Present
        && evidence.record.kind == UnitKind::Reduction
        && locator == &evidence.projection.locator
        && locator.mid == member.message.native_mid
        && locator.index == member.block.index
        && carrier_names_locator(&evidence.carrier, locator)
        && evidence.carrier.role == member.message.role
        && evidence.carrier.ordinal == Some(member.message.ordinal)
        && !evidence.carrier.synthetic
}

fn evaluate_locator_control(control: &UnitLocatorControl) -> Verdict {
    let Some(locator) = control.record.locator.as_ref() else {
        return refuse();
    };
    if locator != &control.projection.locator
        || !carrier_names_locator(&control.carrier, locator)
        || control.member_presence.input_class != "CONSTRUCTED"
    {
        return refuse();
    }

    match &control.record.kind {
        UnitKind::Reduction => {
            if control.carrier.synthetic || control.carrier.ordinal.is_none() {
                return refuse();
            }
            if control.member_presence.state == MemberPresence::Present
                && (locator != &control.member.identity
                    || control.carrier.role != control.member.role
                    || control.carrier.ordinal != Some(control.member.ordinal))
            {
                return refuse();
            }
        }
        UnitKind::Compartment { .. } => {
            if control.member_presence.state != MemberPresence::Absent
                || locator == &control.member.identity
                || control.carrier.role != "user"
                || control.carrier.ordinal.is_some()
                || !control.carrier.synthetic
            {
                return refuse();
            }
        }
    }
    Verdict::Accept
}

fn current_validated_units(vector: &Vector) -> Option<BTreeMap<&str, &UnitEvidence>> {
    let mut validated = BTreeMap::new();
    for evidence in vector
        .unit_evidence
        .iter()
        .filter(|evidence| evidence.validation_scope == ValidationScope::CurrentPass)
    {
        let bytes = decode_base64(&evidence.projection.bytes_base64);
        if evidence.record.locator.as_ref() != Some(&evidence.projection.locator)
            || evidence.record.sha256
                != sha256_hex(&unit_preimage(
                    &evidence.record.unit,
                    evidence.row_version,
                    &bytes,
                ))
            || validated
                .insert(evidence.record.unit.as_str(), evidence)
                .is_some()
        {
            return None;
        }
    }
    Some(validated)
}

fn tool_arcs_match(held: &[ToolArc], successor: &[ToolArc]) -> bool {
    held.len() == successor.len()
        && held
            .iter()
            .zip(successor)
            .all(|(left, right)| left.tool_use_id == right.tool_use_id)
}

fn evaluate(vector: &Vector) -> Verdict {
    // Unit custody is established from this pass's bytes before member proofs can cite it.
    let Some(validated) = current_validated_units(vector) else {
        return refuse();
    };
    let held = &vector.held_m1;
    let successor = &vector.successor_m2;
    let expected_origin = BlockIdentity {
        mid: held.message.native_mid.clone(),
        index: held.block.index,
        ordinal: held.message.ordinal,
    };
    match &successor.block.provenance {
        Provenance::InheritedFrom {
            receipt_id,
            origin_identity,
        } if receipt_id == &vector.origin_receipt_id && origin_identity == &expected_origin => {}
        _ => return refuse(),
    }
    if held.block.kind != successor.block.kind
        || held.block.source != successor.block.source
        || held.message.ordinal != successor.message.ordinal
        || held.block.predecessor_identity != successor.block.predecessor_identity
        || !tool_arcs_match(&held.block.tool_links, &successor.block.tool_links)
    {
        return refuse();
    }

    match (
        held.block.applied_unit.as_deref(),
        successor.block.applied_unit.as_deref(),
    ) {
        (None, None) => {
            if held.block.served != successor.block.served {
                return refuse();
            }
        }
        (Some(_), None) => return refuse(),
        (_, Some(unit)) => {
            let Some(evidence) = validated.get(unit) else {
                return refuse();
            };
            let bytes = decode_base64(&evidence.projection.bytes_base64);
            if evidence.record.kind != UnitKind::Reduction
                || evidence.record.coverage.start > successor.message.ordinal
                || evidence.record.coverage.end < successor.message.ordinal
                || successor.block.served.len != bytes.len() as u64
                || successor.block.served.sha256
                    != sha256_hex(&material_preimage("mc.d5.block.served.v1", &bytes))
            {
                return refuse();
            }
        }
    }
    Verdict::Accept
}

fn expected_verdict(expected: &Expected) -> Verdict {
    match expected.outcome {
        ExpectedOutcome::Accept => {
            assert_eq!(expected.http_status, None);
            assert_eq!(expected.error_code, None);
            Verdict::Accept
        }
        ExpectedOutcome::Refuse => {
            assert_eq!(expected.http_status, Some(503));
            assert_eq!(expected.error_code.as_deref(), Some(PROOF_MISMATCH));
            refuse()
        }
    }
}

fn assert_vector(fixture: &Fixture, id: &str) {
    let vector = vector(fixture, id);
    verify_derivations(vector);
    assert_eq!(evaluate(vector), expected_verdict(&vector.expected), "{id}");
}

#[test]
fn d5_inherited_transfer_oracle_matches_owner_expectations() {
    let (fixture, _) = load_fixture();
    let expected_ids = BTreeSet::from([
        "V01_frozen_twice_inherited",
        "V02_none_to_some",
        "V03_some_to_some",
        "V04_some_to_none",
        "V05_missing_current_unit",
        "V06_source_substitution",
        "V07_frozen_changed_served",
        "V08_origin_uses_predecessor_identity",
        "V09_predecessor_uses_serving_identity",
        "V10_per_hop_mid_reallocation",
    ]);
    assert_eq!(
        fixture
            .vectors
            .iter()
            .map(|vector| vector.id.as_str())
            .collect::<BTreeSet<_>>(),
        expected_ids
    );
    for vector in &fixture.vectors {
        assert!(!vector.name.is_empty());
        assert_eq!(vector.lineage.source_session, "P");
        assert_eq!(vector.lineage.serving_session_m1, "S");
        assert_eq!(vector.lineage.serving_session_m2, "T");
        assert_eq!(vector.lineage.m2_immediate_predecessor, "S");
        match &vector.held_m1.block.provenance {
            Provenance::Native {
                attempt_id,
                predecessor_key,
                message_position,
            } => {
                assert_eq!(attempt_id, "attempt-r1-seal");
                assert_eq!(predecessor_key, "P");
                assert_eq!(*message_position, vector.held_m1.message.ordinal);
            }
            Provenance::InheritedFrom { .. } => panic!("M1 origin must be native"),
        }
        assert_ne!(
            vector.held_m1.message.native_mid,
            vector.successor_m2.message.native_mid
        );
        assert_ne!(
            vector.held_m1.message.native_position,
            vector.successor_m2.message.native_position
        );
        assert_vector(&fixture, &vector.id);
    }
}

#[test]
fn d5_inherited_tool_links_reanchor_without_changing_membership() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V02_none_to_some");
    let held_arc = &vector.held_m1.block.tool_links[0];
    let successor_arc = &vector.successor_m2.block.tool_links[0];
    assert_eq!(held_arc.tool_use_id, successor_arc.tool_use_id);
    assert_ne!(held_arc.use_identity, successor_arc.use_identity);
    assert_eq!(held_arc.result_identity, successor_arc.result_identity);
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_source_sha256_is_anti_substitution_binding() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V06_source_substitution");
    assert_eq!(
        vector.held_m1.block.source.len,
        vector.successor_m2.block.source.len
    );
    assert_ne!(
        vector.held_m1.block.source.sha256,
        vector.successor_m2.block.source.sha256
    );
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_some_to_none_never_resurrects() {
    let (fixture, _) = load_fixture();
    assert_vector(&fixture, "V04_some_to_none");
}

#[test]
fn d5_unit_locators_and_constructed_carriers_obey_returned_view_structure() {
    let (fixture, _) = load_fixture();

    for vector in &fixture.vectors {
        assert_eq!(
            vector.member_presence.input_class, "CONSTRUCTED",
            "{}",
            vector.id
        );
        assert_eq!(
            vector.member_presence.state,
            MemberPresence::Present,
            "{}",
            vector.id
        );
        for evidence in &vector.unit_evidence {
            assert!(
                present_reduction_evidence_is_structural(vector, evidence),
                "{} {}",
                vector.id,
                evidence.record.unit
            );
        }
    }

    let expected_ids = BTreeSet::from([
        "L01_present_reduction_own_location",
        "L02_present_reduction_distinct_location",
        "L03_absent_reduction_independent_location",
        "L04_compartment_synthetic_head",
        "L05_compartment_manifest_location",
        "L06_absent_reduction_same_source_reallocated",
    ]);
    assert_eq!(
        fixture
            .unit_locator_controls
            .iter()
            .map(|control| control.id.as_str())
            .collect::<BTreeSet<_>>(),
        expected_ids
    );
    for control in &fixture.unit_locator_controls {
        assert!(!control.name.is_empty());
        let bytes = decode_base64(&control.projection.bytes_base64);
        assert_eq!(
            control.digest_derivation.preimage_hex,
            hex(&unit_preimage(
                &control.record.unit,
                control.row_version,
                &bytes,
            )),
            "{} records an independently reproducible preimage",
            control.id
        );
        assert_eq!(control.record.sha256, control.digest_derivation.sha256);
        assert_eq!(
            evaluate_locator_control(control),
            expected_verdict(&control.expected),
            "{}",
            control.id
        );
    }

    let absent = fixture
        .unit_locator_controls
        .iter()
        .find(|control| control.id == "L03_absent_reduction_independent_location")
        .expect("absent-member positive control");
    assert_eq!(absent.member_presence.state, MemberPresence::Absent);
    assert_ne!(
        absent.record.locator.as_ref(),
        Some(&absent.member.identity)
    );
    assert_eq!(evaluate_locator_control(absent), Verdict::Accept);

    // An absent member's unit lives in a DIFFERENT message, and an ordinal is a source
    // coordinate: two distinct mids carrying the same ordinal would claim to be the same
    // source message. Stamping a carrier with the absent member's ordinal is the way that
    // contradiction gets written down, so refuse it here rather than in prose.
    for control in &fixture.unit_locator_controls {
        // Refusal controls describe arrangements that are invalid by construction, so their
        // internal coherence proves nothing; only an accepted arrangement must hold together.
        if expected_verdict(&control.expected) != Verdict::Accept {
            continue;
        }
        match control.carrier.source_relation {
            // The member's own message: same mid, same ordinal, by definition.
            CarrierSourceRelation::SameMessage => {
                assert_eq!(
                    control.carrier.mid, control.member.identity.mid,
                    "{}",
                    control.id
                );
                assert_eq!(
                    control.carrier.ordinal,
                    Some(control.member.ordinal),
                    "{}",
                    control.id
                );
            }
            // R24a: a fresh serving mid for the SAME source block keeps its ordinal. This arm
            // exists so the independent-source rule below can never be read as "a different
            // mid means a different source".
            CarrierSourceRelation::SameSourceReallocated => {
                assert_ne!(
                    control.carrier.mid, control.member.identity.mid,
                    "{}",
                    control.id
                );
                assert_eq!(
                    control.carrier.ordinal,
                    Some(control.member.ordinal),
                    "{} reallocates the mid for one source block, so the ordinal holds",
                    control.id
                );
            }
            // A different source message, and the file must say so rather than leave the next
            // reader to infer independence from mid inequality.
            CarrierSourceRelation::IndependentSource => {
                assert_ne!(
                    control.carrier.ordinal,
                    Some(control.member.ordinal),
                    "{} declares an independent source, so it needs its own ordinal",
                    control.id
                );
                assert!(
                    control
                        .carrier
                        .carrier_note
                        .as_ref()
                        .is_some_and(|note| !note.trim().is_empty()),
                    "{} declares an independent source and must say why",
                    control.id
                );
            }
            CarrierSourceRelation::SyntheticHead => {
                assert!(control.carrier.synthetic, "{}", control.id);
                assert_eq!(control.carrier.ordinal, None, "{}", control.id);
            }
        }
    }
}

#[test]
fn d5_inherited_units_must_be_validated_this_pass() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V05_missing_current_unit");
    assert!(vector
        .unit_evidence
        .iter()
        .all(|evidence| evidence.validation_scope != ValidationScope::CurrentPass));
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_digest_domains_bind_through_bytes_without_meeting() {
    let (fixture, _) = load_fixture();
    let reduced = fixture
        .vectors
        .iter()
        .filter(|vector| {
            vector.held_m1.block.applied_unit.is_some()
                || vector.successor_m2.block.applied_unit.is_some()
        })
        .collect::<Vec<_>>();
    assert_eq!(reduced.len(), 4);
    for vector in reduced {
        assert!(
            !vector.unit_evidence.is_empty(),
            "{} has projection bytes",
            vector.id
        );
        verify_derivations(vector);
    }
}

#[test]
fn d5_inherited_origin_identity_must_name_the_cited_manifest_member() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V08_origin_uses_predecessor_identity");
    let expected_manifest_identity = BlockIdentity {
        mid: vector.held_m1.message.native_mid.clone(),
        index: vector.held_m1.block.index,
        ordinal: vector.held_m1.message.ordinal,
    };
    let Provenance::InheritedFrom {
        origin_identity, ..
    } = &vector.successor_m2.block.provenance
    else {
        panic!("successor must cite inherited provenance")
    };

    assert_eq!(origin_identity, &vector.held_m1.block.predecessor_identity);
    assert_ne!(origin_identity, &expected_manifest_identity);
    assert_eq!(
        vector.held_m1.block.predecessor_identity,
        vector.successor_m2.block.predecessor_identity
    );
    assert_eq!(vector.expected.outcome, ExpectedOutcome::Refuse);
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_predecessor_identity_must_still_name_the_source_block() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V09_predecessor_uses_serving_identity");
    let serving_identity = BlockIdentity {
        mid: vector.held_m1.message.native_mid.clone(),
        index: vector.held_m1.block.index,
        ordinal: vector.held_m1.message.ordinal,
    };
    let Provenance::InheritedFrom {
        origin_identity, ..
    } = &vector.successor_m2.block.provenance
    else {
        panic!("successor must cite inherited provenance")
    };

    assert_eq!(origin_identity, &serving_identity);
    assert_eq!(
        vector.successor_m2.block.predecessor_identity,
        serving_identity
    );
    assert_ne!(
        vector.successor_m2.block.predecessor_identity,
        vector.held_m1.block.predecessor_identity
    );
    assert_eq!(vector.expected.outcome, ExpectedOutcome::Refuse);
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_per_hop_mid_reallocation_preserves_source_coordinates() {
    let (fixture, _) = load_fixture();
    let vector = vector(&fixture, "V10_per_hop_mid_reallocation");
    let expected_manifest_identity = BlockIdentity {
        mid: vector.held_m1.message.native_mid.clone(),
        index: vector.held_m1.block.index,
        ordinal: vector.held_m1.message.ordinal,
    };
    let Provenance::InheritedFrom {
        origin_identity, ..
    } = &vector.successor_m2.block.provenance
    else {
        panic!("successor must cite inherited provenance")
    };

    assert_eq!(origin_identity, &expected_manifest_identity);
    assert_eq!(
        vector.held_m1.block.predecessor_identity,
        vector.successor_m2.block.predecessor_identity
    );
    assert_eq!(
        vector.held_m1.message.ordinal,
        vector.successor_m2.message.ordinal
    );
    assert_eq!(
        BTreeSet::from([
            vector.held_m1.block.predecessor_identity.mid.as_str(),
            vector.held_m1.message.native_mid.as_str(),
            vector.successor_m2.message.native_mid.as_str(),
        ])
        .len(),
        3
    );
    assert_eq!(vector.expected.outcome, ExpectedOutcome::Accept);
    assert_vector(&fixture, &vector.id);
}

#[test]
fn d5_inherited_specimen_class_is_algebra_only() {
    let (fixture, _) = load_fixture();
    let specimen = &fixture.specimen_class;

    assert_eq!(specimen.classification, "ALGEBRA");
    assert_eq!(
        specimen.payload_note,
        "Byte payloads are plain text; canonical text blocks are normalizer-produced JSON."
    );
    assert_eq!(specimen.algebra_payload_example, "late reduction\n");
    assert_eq!(
        specimen.canonical_text_block_example,
        r#"{"text":"late reduction\n"}"#
    );
    assert_eq!(specimen.establishes.len(), 6);
    assert!(specimen.presence_note.contains("CONSTRUCTED"));
    assert!(specimen
        .presence_note
        .contains("do not claim observed presence"));
    assert!(specimen.establishes.iter().any(|claim| {
        claim.contains("origin_identity")
            && claim.contains("native_mid")
            && claim.contains("block index")
            && claim.contains("source ordinal")
    }));
    assert!(specimen
        .establishes
        .iter()
        .any(|claim| claim.contains("predecessor_identity independently")));
    assert!(specimen.establishes.iter().any(|claim| {
        claim.contains("mc.d5.block.source.v1") && claim.contains("mc.d5.block.served.v1")
    }));
    assert!(specimen.establishes.iter().any(|claim| {
        claim.contains("mc.d5.unit-projection.v1") && claim.contains("never compared")
    }));
    assert_eq!(
        specimen.does_not_establish,
        [
            "normalized provider-block integration",
            "locator resolution against a real returned view",
        ]
    );
    assert!(specimen.follow_up.contains("real normalizer"));
    assert!(specimen.follow_up.contains("returned-view path"));
}

#[test]
fn d5_twice_inherited_ordinal_names_the_original_source_space() {
    let (fixture, _) = load_fixture();
    let resolution = &fixture.twice_inherited_ordinal_resolution;
    assert_eq!(resolution.status, "settled");
    assert_eq!(resolution.source_space, "P source array");
    assert_eq!(resolution.vector_id, "V01_frozen_twice_inherited");
    assert_eq!(resolution.source_ordinal, 41);
    assert_eq!(resolution.m2_immediate_predecessor, "S");
    assert!(resolution.decision.contains("do not rebase onto S"));
    assert_eq!(resolution.citations.len(), 3);
    assert!(resolution
        .citations
        .iter()
        .any(|citation| citation.contains("R24a")));
    assert!(resolution
        .citations
        .iter()
        .any(|citation| citation.contains("R46e(i)")));
    assert!(resolution
        .citations
        .iter()
        .any(|citation| citation.contains("Contract clause 5")));

    let vector = vector(&fixture, &resolution.vector_id);
    assert_eq!(
        vector.successor_m2.message.ordinal,
        resolution.source_ordinal
    );
    assert_eq!(
        vector.successor_m2.block.predecessor_identity,
        resolution.preserved_predecessor_identity
    );
    assert_eq!(
        vector.held_m1.block.predecessor_identity,
        vector.successor_m2.block.predecessor_identity
    );
}

#[test]
fn d5_inherited_fixture_contract_and_index_are_pinned() {
    let (fixture, fixture_bytes) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.inherited-transfer-vectors.v1");
    assert_eq!(fixture.contract_version, "1.3.38");
    assert_eq!(fixture.ruling_tip, "R46g");
    assert!(fixture
        .predicate_rule
        .unit_validation_order
        .contains("before"));
    assert!(fixture
        .predicate_rule
        .member_join
        .contains("origin_identity"));
    assert!(fixture
        .predicate_rule
        .member_join
        .contains("receipt's manifest"));
    assert!(fixture
        .predicate_rule
        .must_match
        .contains(&"source.sha256".to_owned()));
    assert!(fixture
        .predicate_rule
        .must_match
        .contains(&"ordinal".to_owned()));
    assert!(fixture
        .predicate_rule
        .must_match
        .contains(&"predecessor_identity".to_owned()));
    assert!(fixture
        .predicate_rule
        .may_change
        .contains(&"native_mid".to_owned()));
    assert!(fixture
        .predicate_rule
        .may_change
        .iter()
        .any(|rule| rule.contains("tool_links use_identity")));
    assert!(fixture
        .predicate_rule
        .forbidden
        .contains(&"applied_unit Some to None".to_owned()));
    assert!(fixture
        .predicate_rule
        .digest_domains
        .contains("never compared"));
    assert!(fixture
        .predicate_rule
        .unit_locator_rule
        .contains("present reduced member"));
    assert!(fixture
        .predicate_rule
        .unit_locator_rule
        .contains("absent reduced member"));
    assert!(fixture
        .predicate_rule
        .unit_locator_rule
        .contains("compartment carrier"));
    assert!(fixture
        .predicate_rule
        .refusal_transport
        .contains(PROOF_MISMATCH));
    assert!(fixture
        .predicate_rule
        .expectations
        .contains("owner-authored"));
    assert_eq!(fixture.generation.fixture_kind, "owner-authored");
    assert_eq!(fixture.generation.index_source, INDEX_SOURCE);
    assert_eq!(
        fixture.generation.generation_script,
        "packages/plugin/scripts/gen-d5-specimen-fixture.py"
    );
    assert!(fixture.generation.digest_values.contains("Derived"));

    let index: Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    let entry = index["files"]
        .as_array()
        .expect("index files")
        .iter()
        .find(|entry| entry["path"] == FIXTURE_NAME)
        .expect("inherited fixture index entry");
    assert_eq!(
        entry["byte_size"].as_u64(),
        Some(fixture_bytes.len() as u64)
    );
    assert_eq!(
        entry["sha256"].as_str(),
        Some(sha256_hex(&fixture_bytes).as_str())
    );
    assert_eq!(entry["derived"].as_bool(), Some(false));
    assert_eq!(entry["source"].as_str(), Some(INDEX_SOURCE));
    assert_eq!(
        entry["generation_script"].as_str(),
        Some("packages/plugin/scripts/gen-d5-specimen-fixture.py")
    );
}
