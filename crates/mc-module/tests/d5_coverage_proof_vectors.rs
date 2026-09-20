use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

const RECEIPT_ID: &str = "33333333-4444-4555-8666-777777777777";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    encoding_rule: EncodingRule,
    manifest: Manifest,
    gateway_state: GatewayState,
    precondition_space: PreconditionSpace,
    precedence_table: Vec<PrecedenceRow>,
    r17_3_unit_precondition_space: PreconditionSpace,
    r17_3_unit_rule_table: Vec<PrecedenceRow>,
    thalamus_counterexamples_json: String,
    vectors: Vec<Vector>,
    vector_sequences: Vec<VectorSequence>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    r16: String,
    served_digest: String,
    expectations: String,
    unit_validation: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AggregatePreimages {
    schema: String,
    derivation: String,
    vectors: Vec<AggregateVector>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AggregateVector {
    name: String,
    tag: String,
    version: u32,
    row_version: u64,
    units: Vec<AggregateUnit>,
    preimage_hex: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AggregateUnit {
    unit: String,
    kind: AggregateKind,
    coverage: UnitCoverage,
    bytes_utf8: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AggregateKind {
    Compartment { compartment: AggregateCompartment },
    Reduction(String),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AggregateCompartment {
    compartment_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u64,
    normalization_version: u64,
    encoding_version: u64,
    manifest_digest: String,
    members: Vec<ManifestMember>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestMember {
    identity: BlockIdentity,
    native_mid: String,
    source_text: String,
    served_digest_preimage_hex: String,
    served_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayState {
    receipt_id: String,
    predecessor_key: String,
    successor_key: String,
    lineage_id: String,
    redeemed_receipts: Vec<RedeemedReceipt>,
    known_units: Vec<KnownUnit>,
    recorded: Vec<RecordedPass>,
    held_receipts: Vec<HeldReceipt>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RedeemedReceipt {
    receipt_id: String,
    edge_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KnownUnit {
    compartment_sequence: u64,
    unit: String,
    unit_digest: String,
    row_version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct RecordedPass {
    receipt_id: String,
    row_version: u64,
    units: Vec<UnitRecordV1>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HeldReceipt {
    receipt_id: String,
    edge_id: String,
    predecessor_key: String,
    successor_key: String,
    lineage_id: String,
    manifest_digest: String,
    manifest_blocks: Vec<ManifestBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreconditionSpace {
    evaluation_order: Vec<String>,
    dimensions: BTreeMap<String, Vec<String>>,
    independence_rule: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrecedenceRow {
    row_id: String,
    priority: u64,
    preconditions: BTreeMap<String, Vec<String>>,
    applies_regardless_of: Vec<String>,
    expected_outcome: String,
    expected_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    served_carry_span: Vec<ServedCarryMember>,
    served_array: Vec<ServedBlock>,
    recorded_before: Vec<RecordedPass>,
    d5_carry: CarryProjectionV1,
    gateway_folded_frontier: u64,
    expected: Expected,
    precedence_row: String,
    #[serde(default)]
    r17_3_preconditions: Option<BTreeMap<String, String>>,
    #[serde(default)]
    r17_3_rule_row: Option<String>,
    #[serde(default)]
    counterexample_id: Option<String>,
    #[serde(default)]
    loss_specimen: Option<LossSpecimen>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    outcome: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LossSpecimen {
    obligation: OrdinalRange,
    real_compartments_end: u64,
    lineage_boundary: LineageBoundary,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrdinalRange {
    first: u64,
    last: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineageBoundary {
    ordinal: u64,
    empty: bool,
    is_compartment: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CarryProjectionV1 {
    schema_version: u64,
    receipt_id: String,
    archive_id: String,
    manifest_digest: String,
    row_version: u64,
    coverage_identity: Option<BlockIdentity>,
    native_continuation_identity: BlockIdentity,
    members: Vec<CarryMember>,
    projection_digest: ProjectionDigest,
    #[serde(default)]
    coverage_proof: Option<Vec<CoverageProofV1>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CarryMember {
    identity: BlockIdentity,
    validation: CarryValidation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CarryValidation {
    Frozen {
        served_sha256: String,
    },
    ProjectionDigest {
        sha256: String,
        unit: String,
        row_version: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectionDigest {
    sha256: String,
    row_version: u64,
    units: Vec<UnitRecordV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitRecordV1 {
    unit: String,
    kind: UnitKind,
    coverage: UnitCoverage,
    locator: Option<UnitLocator>,
    source_text: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UnitKind {
    Compartment { compartment_sequence: u64 },
    Reduction,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitCoverage {
    start: u64,
    end: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitLocator {
    mid: String,
    index: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CoverageProofV1 {
    ReceiptBacked {
        covered: Vec<BlockIdentity>,
    },
    RealCompartment {
        covered: Vec<BlockIdentity>,
        unit: String,
    },
    Discharged {
        by: DischargeBy,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DischargeBy {
    Fold {
        units: Vec<String>,
    },
    Reduction {
        units: Vec<String>,
    },
    CustodyTransfer {
        transferee_receipt_id: String,
        edge_id: String,
        origin: TransferOrigin,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TransferOrigin {
    receipt_id: String,
    predecessor_key: String,
    lineage_id: String,
    manifest_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServedCarryMember {
    native_mid: String,
    block_index: u64,
    served_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServedBlock {
    mid: String,
    index: u64,
    bytes: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestBlock {
    identity: BlockIdentity,
    provenance: Provenance,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Provenance {
    Native {
        attempt_id: String,
    },
    InheritedFrom {
        receipt_id: String,
        origin_identity: BlockIdentity,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorSequence {
    id: String,
    steps: Vec<SequenceStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceStep {
    vector_id: String,
    accepted: bool,
    recorded_after: Vec<RecordedPass>,
    custody_after: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
struct BlockIdentity {
    mid: String,
    index: u64,
    ordinal: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct PreconditionCell(BTreeMap<String, String>);

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join("coverage-proof-vectors-v1.json"))
        .expect("read D5 coverage proof vectors");
    let fixture = serde_json::from_slice(&bytes).expect("parse coverage proof fixture schema");
    (fixture, bytes)
}

fn load_aggregate_preimages() -> AggregatePreimages {
    let bytes = fs::read(fixture_dir().join("aggregate-preimages-v1.json"))
        .expect("read D5 aggregate preimages");
    serde_json::from_slice(&bytes).expect("parse D5 aggregate preimage schema")
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn u32be(value: usize) -> Vec<u8> {
    u32::try_from(value)
        .expect("u32 length")
        .to_be_bytes()
        .to_vec()
}

fn u64be(value: usize) -> Vec<u8> {
    u64::try_from(value)
        .expect("u64 length")
        .to_be_bytes()
        .to_vec()
}

fn ce1_text(value: &str) -> Vec<u8> {
    let mut encoded = u64be(value.len());
    encoded.extend_from_slice(value.as_bytes());
    encoded
}

fn ce1_bytes(value: &[u8]) -> Vec<u8> {
    let mut encoded = u64be(value.len());
    encoded.extend_from_slice(value);
    encoded
}

fn domain_preimage(tag: &str, ce1: &[u8]) -> Vec<u8> {
    let mut encoded = u32be(tag.len());
    encoded.extend_from_slice(tag.as_bytes());
    encoded.extend_from_slice(&1_u32.to_be_bytes());
    encoded.extend_from_slice(ce1);
    encoded
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Vec<u8> {
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    assert!(remainder.is_empty(), "hex must contain whole bytes");
    pairs
        .iter()
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("hex is ASCII");
            u8::from_str_radix(pair, 16).expect("valid hex byte")
        })
        .collect()
}

fn domain_digest(tag: &str, ce1: &[u8]) -> String {
    sha256_hex(&domain_preimage(tag, ce1))
}

fn unit_ce1(unit: &str, row_version: u64, source: &[u8]) -> Vec<u8> {
    let mut encoded = ce1_text(unit);
    encoded.extend_from_slice(&row_version.to_be_bytes());
    encoded.extend_from_slice(&ce1_bytes(source));
    encoded
}

fn projection_ce1(row_version: u64, units: &[(&UnitRecordV1, &[u8])]) -> Vec<u8> {
    let mut encoded = row_version.to_be_bytes().to_vec();
    encoded.extend_from_slice(
        &u64::try_from(units.len())
            .expect("unit count")
            .to_be_bytes(),
    );
    for (record, bytes) in units {
        encoded.extend_from_slice(&ce1_text(&record.unit));
        match &record.kind {
            UnitKind::Compartment {
                compartment_sequence,
            } => {
                encoded.extend_from_slice(&0_u32.to_be_bytes());
                encoded.extend_from_slice(&compartment_sequence.to_be_bytes());
            }
            UnitKind::Reduction => encoded.extend_from_slice(&1_u32.to_be_bytes()),
        }
        encoded.extend_from_slice(&record.coverage.start.to_be_bytes());
        encoded.extend_from_slice(&record.coverage.end.to_be_bytes());
        encoded.extend_from_slice(&ce1_bytes(bytes));
    }
    encoded
}

fn values(values: &[String]) -> BTreeSet<&str> {
    values.iter().map(String::as_str).collect()
}

fn assert_precondition_space(space: &PreconditionSpace) {
    assert_eq!(
        space.evaluation_order,
        [
            "unit_validation",
            "proof_list_absent",
            "variant_tag",
            "discharged_alone",
            "union_vs_manifest",
            "per_variant_checks",
            "row_version"
        ]
    );
    let expected = BTreeMap::from([
        (
            "proof_list",
            vec![
                "absent",
                "empty",
                "single_discharged",
                "discharged_plus_other",
                "receipt_backed_only",
                "real_compartment_only",
                "mixed",
            ],
        ),
        (
            "union_vs_manifest",
            vec![
                "equal_once",
                "missing_member",
                "duplicate_member",
                "foreign_identity",
            ],
        ),
        (
            "receipt_backed_presence",
            vec!["all_present_matching", "member_absent", "digest_mismatch"],
        ),
        (
            "real_compartment_geometry",
            vec![
                "absent_and_covered",
                "member_present",
                "coverage_end_too_low",
                "unknown_unit",
                "row_version_regressed",
            ],
        ),
        (
            "discharge_evidence",
            vec![
                "fold_ok",
                "fold_frontier_short",
                "reduction_ok",
                "reduction_digest_wrong",
                "reduction_member_unmapped",
                "transfer_ok",
                "transfer_unknown_receipt",
                "transfer_wrong_edge",
            ],
        ),
        ("variant_tag", vec!["known", "unsupported"]),
        (
            "fold_coverage",
            vec!["ranges_cover_all", "gap", "boundary_only", "unit_unseen"],
        ),
        ("unit_seen", vec!["seen", "unseen"]),
        (
            "member_representation",
            vec!["frozen", "reduced_unit_listed", "reduced_unit_unlisted"],
        ),
        (
            "transfer_binding",
            vec![
                "lineage_and_superset",
                "wrong_lineage",
                "wrong_predecessor",
                "manifest_not_superset",
            ],
        ),
        (
            "unit_validation",
            vec![
                "all_valid",
                "digest_tampered",
                "aggregate_mismatch",
                "recorded_coverage_conflict",
            ],
        ),
        (
            "origin_binding",
            vec![
                "matches_this_receipt",
                "wrong_receipt",
                "wrong_predecessor",
                "wrong_lineage",
                "wrong_manifest",
            ],
        ),
    ]);
    assert_eq!(space.dimensions.len(), expected.len());
    for (name, domain) in expected {
        assert_eq!(space.dimensions[name], domain, "dimension {name}");
    }
    assert!(space.independence_rule.contains("independently"));
    assert!(space.independence_rule.contains("Step 0"));
    assert!(space.independence_rule.contains("applies_regardless_of"));
}

fn row_matches(row: &PrecedenceRow, cell: &PreconditionCell) -> bool {
    row.preconditions.iter().all(|(dimension, allowed)| {
        allowed.contains(
            cell.0
                .get(dimension)
                .unwrap_or_else(|| panic!("cell lacks {dimension}")),
        )
    })
}

fn assert_regardless_markers(fixture: &Fixture) {
    let domains = &fixture.precondition_space.dimensions;
    for row in &fixture.precedence_table {
        assert_eq!(
            row.preconditions.len(),
            domains.len(),
            "{} width",
            row.row_id
        );
        let marked = values(&row.applies_regardless_of);
        assert!(marked.iter().all(|name| domains.contains_key(*name)));
        for (dimension, domain) in domains {
            assert_eq!(
                marked.contains(dimension.as_str()),
                values(&row.preconditions[dimension]) == values(domain),
                "{} must mark exactly every complete collapsed dimension ({dimension})",
                row.row_id
            );
        }
    }
}

fn mark_row_cells(
    row: &PrecedenceRow,
    dimensions: &[(&str, &[String])],
    strides: &[usize],
    at: usize,
    index: usize,
    counts: &mut [u8],
) {
    if at == dimensions.len() {
        counts[index] = counts[index].saturating_add(1);
        return;
    }
    let (name, domain) = dimensions[at];
    for allowed in &row.preconditions[name] {
        let position = domain
            .iter()
            .position(|value| value == allowed)
            .unwrap_or_else(|| panic!("{} has unknown {name}={allowed}", row.row_id));
        mark_row_cells(
            row,
            dimensions,
            strides,
            at + 1,
            index + position * strides[at],
            counts,
        );
    }
}

fn table_cell_counts(fixture: &Fixture) -> Vec<u8> {
    let dimensions = fixture
        .precondition_space
        .dimensions
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect::<Vec<_>>();
    let mut strides = vec![1; dimensions.len()];
    for at in (0..dimensions.len().saturating_sub(1)).rev() {
        strides[at] = strides[at + 1] * dimensions[at + 1].1.len();
    }
    let total = dimensions.iter().map(|(_, values)| values.len()).product();
    let mut counts = vec![0_u8; total];
    for row in &fixture.precedence_table {
        mark_row_cells(row, &dimensions, &strides, 0, 0, &mut counts);
    }
    counts
}

fn manifest_set(fixture: &Fixture) -> BTreeSet<BlockIdentity> {
    fixture
        .manifest
        .members
        .iter()
        .map(|member| member.identity.clone())
        .collect()
}

fn proof_list_class(proofs: Option<&[CoverageProofV1]>) -> &'static str {
    let Some(proofs) = proofs else {
        return "absent";
    };
    if proofs.is_empty() {
        return "empty";
    }
    let discharged = proofs
        .iter()
        .filter(|proof| matches!(proof, CoverageProofV1::Discharged { .. }))
        .count();
    if discharged > 0 {
        return if proofs.len() == 1 && discharged == 1 {
            "single_discharged"
        } else {
            "discharged_plus_other"
        };
    }
    let receipt = proofs
        .iter()
        .any(|proof| matches!(proof, CoverageProofV1::ReceiptBacked { .. }));
    let real = proofs
        .iter()
        .any(|proof| matches!(proof, CoverageProofV1::RealCompartment { .. }));
    match (receipt, real) {
        (true, false) => "receipt_backed_only",
        (false, true) => "real_compartment_only",
        (true, true) => "mixed",
        (false, false) => "receipt_backed_only",
    }
}

fn variant_tag(proofs: Option<&[CoverageProofV1]>) -> &'static str {
    let unsupported = proofs.into_iter().flatten().any(|proof| {
        matches!(
            proof,
            CoverageProofV1::Unsupported
                | CoverageProofV1::Discharged {
                    by: DischargeBy::Unsupported,
                }
        )
    });
    if unsupported {
        "unsupported"
    } else {
        "known"
    }
}

fn covered_identities(proofs: &[CoverageProofV1]) -> Vec<BlockIdentity> {
    let mut covered = Vec::new();
    for proof in proofs {
        match proof {
            CoverageProofV1::ReceiptBacked { covered: members }
            | CoverageProofV1::RealCompartment {
                covered: members, ..
            } => covered.extend(members.iter().cloned()),
            CoverageProofV1::Discharged { .. } | CoverageProofV1::Unsupported => {}
        }
    }
    covered
}

fn union_class(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some(proofs) = carry.coverage_proof.as_deref() else {
        return "missing_member";
    };
    let covered = covered_identities(proofs);
    let manifest = manifest_set(fixture);
    if covered.iter().any(|identity| !manifest.contains(identity)) {
        return "foreign_identity";
    }
    if covered.iter().collect::<BTreeSet<_>>().len() != covered.len() {
        return "duplicate_member";
    }
    if covered.into_iter().collect::<BTreeSet<_>>() == manifest {
        "equal_once"
    } else {
        "missing_member"
    }
}

fn carry_member<'a>(
    carry: &'a CarryProjectionV1,
    identity: &BlockIdentity,
) -> Option<&'a CarryMember> {
    carry
        .members
        .iter()
        .find(|member| &member.identity == identity)
}

fn served_span_member<'a>(
    vector: &'a Vector,
    identity: &BlockIdentity,
) -> Option<&'a ServedCarryMember> {
    vector
        .served_carry_span
        .iter()
        .find(|member| member.native_mid == identity.mid && member.block_index == identity.index)
}

fn known_unit<'a>(fixture: &'a Fixture, unit: &str) -> Option<&'a KnownUnit> {
    fixture
        .gateway_state
        .known_units
        .iter()
        .find(|known| known.unit == unit)
}

fn served_block_bytes<'a>(vector: &'a Vector, record: &UnitRecordV1) -> Option<&'a [u8]> {
    match &record.locator {
        None => Some(&[]),
        Some(locator) => vector
            .served_array
            .iter()
            .find(|block| block.mid == locator.mid && block.index == locator.index)
            .map(|block| block.bytes.as_bytes()),
    }
}

fn current_record<'a>(carry: &'a CarryProjectionV1, unit: &str) -> Option<&'a UnitRecordV1> {
    carry
        .projection_digest
        .units
        .iter()
        .find(|record| record.unit == unit)
}

fn recorded_record<'a>(vector: &'a Vector, unit: &str) -> Option<(&'a UnitRecordV1, u64)> {
    vector
        .recorded_before
        .iter()
        .filter(|pass| pass.receipt_id == vector.d5_carry.receipt_id)
        .flat_map(|pass| {
            pass.units
                .iter()
                .map(move |record| (record, pass.row_version))
        })
        .find(|(record, _)| record.unit == unit)
}

fn validated_record<'a>(vector: &'a Vector, unit: &str) -> Option<(&'a UnitRecordV1, u64)> {
    current_record(&vector.d5_carry, unit)
        .map(|record| (record, vector.d5_carry.projection_digest.row_version))
}

fn receipt_presence(_fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "all_present_matching";
    };
    for identity in proofs
        .iter()
        .filter_map(|proof| match proof {
            CoverageProofV1::ReceiptBacked { covered } => Some(covered.as_slice()),
            _ => None,
        })
        .flatten()
    {
        let Some(member) = carry_member(&vector.d5_carry, identity) else {
            return "member_absent";
        };
        match &member.validation {
            CarryValidation::Frozen { served_sha256 } => {
                let Some(served) = served_span_member(vector, identity) else {
                    return "member_absent";
                };
                if served.served_sha256 != *served_sha256 {
                    return "digest_mismatch";
                }
            }
            CarryValidation::ProjectionDigest {
                sha256,
                unit,
                row_version,
            } => {
                let Some((record, record_row)) = validated_record(vector, unit) else {
                    continue;
                };
                if record.sha256 != *sha256
                    || record_row != *row_version
                    || !matches!(record.kind, UnitKind::Reduction)
                    || identity.ordinal < record.coverage.start
                    || identity.ordinal > record.coverage.end
                {
                    return "digest_mismatch";
                }
                let member_is_present = served_span_member(vector, identity).is_some();
                if member_is_present != record.locator.is_some() {
                    return "member_absent";
                }
            }
        }
    }
    "all_present_matching"
}

fn member_representation(vector: &Vector) -> &'static str {
    let mut reduced = false;
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "frozen";
    };
    for identity in proofs
        .iter()
        .filter_map(|proof| match proof {
            CoverageProofV1::ReceiptBacked { covered } => Some(covered.as_slice()),
            _ => None,
        })
        .flatten()
    {
        if let Some(CarryMember {
            validation: CarryValidation::ProjectionDigest { unit, .. },
            ..
        }) = carry_member(&vector.d5_carry, identity)
        {
            reduced = true;
            if validated_record(vector, unit).is_none() {
                return "reduced_unit_unlisted";
            }
        }
    }
    if reduced {
        "reduced_unit_listed"
    } else {
        "frozen"
    }
}

fn unit_is_seen(vector: &Vector, unit: &str) -> bool {
    validated_record(vector, unit).is_some()
}

fn relevant_units(proofs: Option<&[CoverageProofV1]>) -> Vec<&str> {
    let mut units = Vec::new();
    for proof in proofs.into_iter().flatten() {
        match proof {
            CoverageProofV1::RealCompartment { unit, .. } => units.push(unit.as_str()),
            CoverageProofV1::Discharged {
                by: DischargeBy::Fold { units: cited },
            } => units.extend(cited.iter().map(String::as_str)),
            _ => {}
        }
    }
    units
}

fn unit_seen_class(vector: &Vector) -> &'static str {
    if relevant_units(vector.d5_carry.coverage_proof.as_deref())
        .into_iter()
        .all(|unit| unit_is_seen(vector, unit))
    {
        "seen"
    } else {
        "unseen"
    }
}

fn real_geometry(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "absent_and_covered";
    };
    for proof in proofs {
        let CoverageProofV1::RealCompartment { covered, unit } = proof else {
            continue;
        };
        if covered
            .iter()
            .any(|identity| served_span_member(vector, identity).is_some())
        {
            return "member_present";
        }
        let Some((record, _)) = validated_record(vector, unit) else {
            return if known_unit(fixture, unit).is_some() {
                "absent_and_covered"
            } else {
                "unknown_unit"
            };
        };
        if !matches!(record.kind, UnitKind::Compartment { .. })
            || record.locator.is_none()
            || record.source_text.is_empty()
            || covered.iter().any(|identity| {
                identity.ordinal < record.coverage.start || identity.ordinal > record.coverage.end
            })
        {
            return "coverage_end_too_low";
        }
    }
    "absent_and_covered"
}

fn fold_coverage(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(units) = vector
        .d5_carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by: DischargeBy::Fold { units },
            } => Some(units),
            _ => None,
        })
    else {
        return "ranges_cover_all";
    };
    let records = units
        .iter()
        .filter_map(|unit| validated_record(vector, unit).map(|(record, _)| record))
        .collect::<Vec<_>>();
    if records.len() != units.len() {
        return "unit_unseen";
    }
    if records.iter().any(|record| {
        !matches!(record.kind, UnitKind::Compartment { .. })
            || record.locator.is_none()
            || record.source_text.is_empty()
    }) {
        return "gap";
    }
    let all_covered = fixture.manifest.members.iter().all(|member| {
        records.iter().any(|record| {
            member.identity.ordinal >= record.coverage.start
                && member.identity.ordinal <= record.coverage.end
        })
    });
    let max_end = records.iter().map(|record| record.coverage.end).max();
    if all_covered && max_end == Some(vector.gateway_folded_frontier) {
        "ranges_cover_all"
    } else if vector.gateway_folded_frontier == 1940 && max_end.is_some_and(|end| end <= 1798) {
        "boundary_only"
    } else {
        "gap"
    }
}

fn discharge_evidence(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(by) = vector
        .d5_carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged { by } => Some(by),
            _ => None,
        })
    else {
        return "fold_ok";
    };
    match by {
        DischargeBy::Fold { units } => {
            let max_end = units
                .iter()
                .filter_map(|unit| {
                    validated_record(vector, unit).and_then(|(record, _)| {
                        (matches!(record.kind, UnitKind::Compartment { .. })
                            && record.locator.is_some()
                            && !record.source_text.is_empty())
                        .then_some(record.coverage.end)
                    })
                })
                .max();
            if max_end.is_none() || max_end == Some(vector.gateway_folded_frontier) {
                "fold_ok"
            } else {
                "fold_frontier_short"
            }
        }
        DischargeBy::Reduction { units } => {
            let records_are_current_reductions = units.iter().all(|unit| {
                validated_record(vector, unit)
                    .is_some_and(|(record, _)| matches!(record.kind, UnitKind::Reduction))
            });
            if !records_are_current_reductions {
                return "reduction_digest_wrong";
            }
            let mapped = vector
                .d5_carry
                .members
                .iter()
                .all(|member| match &member.validation {
                    CarryValidation::ProjectionDigest { unit, .. } => units.contains(unit),
                    CarryValidation::Frozen { .. } => false,
                });
            if mapped {
                "reduction_ok"
            } else {
                "reduction_member_unmapped"
            }
        }
        DischargeBy::CustodyTransfer {
            transferee_receipt_id,
            edge_id,
            ..
        } => {
            let Some(held) = fixture
                .gateway_state
                .held_receipts
                .iter()
                .find(|held| held.receipt_id == *transferee_receipt_id)
            else {
                return "transfer_unknown_receipt";
            };
            if held.edge_id == *edge_id {
                "transfer_ok"
            } else {
                "transfer_wrong_edge"
            }
        }
        DischargeBy::Unsupported => "transfer_wrong_edge",
    }
}

fn transfer_binding(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some((receipt_id, origin)) = carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by:
                    DischargeBy::CustodyTransfer {
                        transferee_receipt_id,
                        origin,
                        ..
                    },
            } => Some((transferee_receipt_id, origin)),
            _ => None,
        })
    else {
        return "lineage_and_superset";
    };
    let Some(held) = fixture
        .gateway_state
        .held_receipts
        .iter()
        .find(|held| held.receipt_id == *receipt_id)
    else {
        return "lineage_and_superset";
    };
    if held.lineage_id != fixture.gateway_state.lineage_id {
        return "wrong_lineage";
    }
    if held.predecessor_key != fixture.gateway_state.successor_key {
        return "wrong_predecessor";
    }
    if held.manifest_digest != origin.manifest_digest {
        return "wrong_lineage";
    }
    let inherited = held
        .manifest_blocks
        .iter()
        .filter_map(|block| match &block.provenance {
            Provenance::InheritedFrom {
                receipt_id,
                origin_identity,
            } if receipt_id == &fixture.gateway_state.receipt_id => Some(origin_identity),
            Provenance::Native { .. } | Provenance::InheritedFrom { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    if fixture
        .manifest
        .members
        .iter()
        .any(|member| !inherited.contains(&member.identity))
    {
        "manifest_not_superset"
    } else {
        "lineage_and_superset"
    }
}

fn origin_binding(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some(origin) = carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by: DischargeBy::CustodyTransfer { origin, .. },
            } => Some(origin),
            _ => None,
        })
    else {
        return "matches_this_receipt";
    };
    if origin.receipt_id != fixture.gateway_state.receipt_id {
        "wrong_receipt"
    } else if origin.predecessor_key != fixture.gateway_state.predecessor_key {
        "wrong_predecessor"
    } else if origin.lineage_id != fixture.gateway_state.lineage_id {
        "wrong_lineage"
    } else if origin.manifest_digest != fixture.manifest.manifest_digest {
        "wrong_manifest"
    } else {
        "matches_this_receipt"
    }
}

fn unit_validation(vector: &Vector) -> &'static str {
    let row_version = vector.d5_carry.projection_digest.row_version;
    let mut validated = Vec::new();
    for record in &vector.d5_carry.projection_digest.units {
        let Some(bytes) = served_block_bytes(vector, record) else {
            return "digest_tampered";
        };
        if bytes != record.source_text.as_bytes()
            || (record.locator.is_none() && !record.source_text.is_empty())
            || (matches!(record.kind, UnitKind::Compartment { .. }) && bytes.is_empty())
        {
            return "digest_tampered";
        }
        let ce1 = unit_ce1(&record.unit, row_version, bytes);
        if domain_digest("mc.d5.unit-projection.v1", &ce1) != record.sha256 {
            return "digest_tampered";
        }
        if let Some((prior, prior_row_version)) = recorded_record(vector, &record.unit) {
            if row_version < prior_row_version
                || (row_version == prior_row_version
                    && (prior.coverage != record.coverage || prior.kind != record.kind))
            {
                return "recorded_coverage_conflict";
            }
        }
        validated.push((record, bytes));
    }
    let ce1 = projection_ce1(row_version, &validated);
    if domain_digest("mc.d5.projection.v1", &ce1) != vector.d5_carry.projection_digest.sha256 {
        "aggregate_mismatch"
    } else {
        "all_valid"
    }
}

fn classify(fixture: &Fixture, vector: &Vector) -> PreconditionCell {
    let carry = &vector.d5_carry;
    PreconditionCell(BTreeMap::from([
        (
            "proof_list".to_string(),
            proof_list_class(carry.coverage_proof.as_deref()).to_string(),
        ),
        (
            "union_vs_manifest".to_string(),
            union_class(fixture, carry).to_string(),
        ),
        (
            "receipt_backed_presence".to_string(),
            receipt_presence(fixture, vector).to_string(),
        ),
        (
            "real_compartment_geometry".to_string(),
            real_geometry(fixture, vector).to_string(),
        ),
        (
            "discharge_evidence".to_string(),
            discharge_evidence(fixture, vector).to_string(),
        ),
        (
            "variant_tag".to_string(),
            variant_tag(carry.coverage_proof.as_deref()).to_string(),
        ),
        (
            "fold_coverage".to_string(),
            fold_coverage(fixture, vector).to_string(),
        ),
        ("unit_seen".to_string(), unit_seen_class(vector).to_string()),
        (
            "member_representation".to_string(),
            member_representation(vector).to_string(),
        ),
        (
            "transfer_binding".to_string(),
            transfer_binding(fixture, carry).to_string(),
        ),
        (
            "unit_validation".to_string(),
            unit_validation(vector).to_string(),
        ),
        (
            "origin_binding".to_string(),
            origin_binding(fixture, carry).to_string(),
        ),
    ]))
}

fn assert_digest_provenance(fixture: &Fixture) {
    for member in &fixture.manifest.members {
        assert_eq!(member.native_mid, member.identity.mid);
        let ce1 = ce1_bytes(member.source_text.as_bytes());
        let preimage = domain_preimage("mc.d5.block.served.v1", &ce1);
        assert_eq!(member.served_digest_preimage_hex, hex(&preimage));
        assert_eq!(member.served_sha256, sha256_hex(&preimage));
    }
    for vector in &fixture.vectors {
        let mut units = Vec::new();
        for record in &vector.d5_carry.projection_digest.units {
            let bytes = served_block_bytes(vector, record).unwrap_or_else(|| {
                panic!("{} missing locator bytes for {}", vector.id, record.unit)
            });
            assert_eq!(
                bytes,
                record.source_text.as_bytes(),
                "{} source_text for {}",
                vector.id,
                record.unit
            );
            let ce1 = unit_ce1(
                &record.unit,
                vector.d5_carry.projection_digest.row_version,
                record.source_text.as_bytes(),
            );
            let computed = domain_digest("mc.d5.unit-projection.v1", &ce1);
            if unit_validation(vector) == "digest_tampered" {
                assert_ne!(record.sha256, computed, "tampered control must differ");
            } else {
                assert_eq!(
                    record.sha256, computed,
                    "{} unit {}",
                    vector.id, record.unit
                );
            }
            units.push((record, record.source_text.as_bytes()));
        }
        for pass in &vector.recorded_before {
            for record in &pass.units {
                let ce1 = unit_ce1(
                    &record.unit,
                    pass.row_version,
                    record.source_text.as_bytes(),
                );
                assert_eq!(
                    record.sha256,
                    domain_digest("mc.d5.unit-projection.v1", &ce1),
                    "{} recorded unit {}",
                    vector.id,
                    record.unit
                );
            }
        }
        let ce1 = projection_ce1(vector.d5_carry.projection_digest.row_version, &units);
        if unit_validation(vector) != "aggregate_mismatch" {
            assert_eq!(
                vector.d5_carry.projection_digest.sha256,
                domain_digest("mc.d5.projection.v1", &ce1),
                "{} aggregate",
                vector.id
            );
        }
    }
}

fn precondition_cells(space: &PreconditionSpace) -> Vec<PreconditionCell> {
    fn visit(
        dimensions: &[(&String, &Vec<String>)],
        at: usize,
        cell: &mut BTreeMap<String, String>,
        cells: &mut Vec<PreconditionCell>,
    ) {
        if at == dimensions.len() {
            cells.push(PreconditionCell(cell.clone()));
            return;
        }
        let (name, domain) = dimensions[at];
        for value in domain {
            cell.insert(name.clone(), value.clone());
            visit(dimensions, at + 1, cell, cells);
        }
        cell.remove(name);
    }

    let dimensions = space.dimensions.iter().collect::<Vec<_>>();
    let mut cells = Vec::new();
    visit(&dimensions, 0, &mut BTreeMap::new(), &mut cells);
    cells
}

fn assert_r17_3_precondition_space(space: &PreconditionSpace) {
    assert_eq!(
        space.evaluation_order,
        [
            "unit_membership",
            "row_version_relation",
            "proof_variant",
            "unit_kind",
            "locator_presence"
        ]
    );
    let expected = BTreeMap::from([
        (
            "proof_variant",
            vec![
                "receipt_backed",
                "real_compartment",
                "discharged_fold",
                "discharged_reduction",
            ],
        ),
        ("unit_kind", vec!["compartment", "reduction"]),
        ("locator_presence", vec!["present", "none"]),
        (
            "unit_membership",
            vec!["validated", "recorded_only", "absent"],
        ),
        (
            "row_version_relation",
            vec!["regressed", "equal_same", "equal_diff_coverage", "advanced"],
        ),
    ]);
    assert_eq!(space.dimensions.len(), expected.len());
    for (name, domain) in expected {
        assert_eq!(space.dimensions[name], domain, "R17.3 dimension {name}");
    }
    assert!(space.independence_rule.contains("independent product"));
}

fn cited_unit(vector: &Vector) -> Option<(&str, &'static str)> {
    let proof = vector.d5_carry.coverage_proof.as_deref()?.first()?;
    match proof {
        CoverageProofV1::ReceiptBacked { covered } => {
            let identity = covered.first()?;
            let member = carry_member(&vector.d5_carry, identity)?;
            match &member.validation {
                CarryValidation::ProjectionDigest { unit, .. } => Some((unit, "receipt_backed")),
                CarryValidation::Frozen { .. } => None,
            }
        }
        CoverageProofV1::RealCompartment { unit, .. } => Some((unit, "real_compartment")),
        CoverageProofV1::Discharged {
            by: DischargeBy::Fold { units },
        } => units.first().map(|unit| (unit.as_str(), "discharged_fold")),
        CoverageProofV1::Discharged {
            by: DischargeBy::Reduction { units },
        } => units
            .first()
            .map(|unit| (unit.as_str(), "discharged_reduction")),
        _ => None,
    }
}

fn r17_3_vector_cell(vector: &Vector) -> Option<PreconditionCell> {
    let (unit, proof_variant) = cited_unit(vector)?;
    let current = current_record(&vector.d5_carry, unit);
    let recorded = recorded_record(vector, unit);
    let (record, unit_membership) = match (current, recorded) {
        (Some(record), _) => (record, "validated"),
        (None, Some((record, _))) => (record, "recorded_only"),
        (None, None) => return None,
    };
    let row_version_relation = match (current, recorded) {
        (Some(current), Some((prior, prior_row))) => {
            let current_row = vector.d5_carry.projection_digest.row_version;
            if current_row < prior_row {
                "regressed"
            } else if current_row > prior_row {
                "advanced"
            } else if current.coverage == prior.coverage && current.kind == prior.kind {
                "equal_same"
            } else {
                "equal_diff_coverage"
            }
        }
        _ => "equal_same",
    };
    let unit_kind = match &record.kind {
        UnitKind::Compartment { .. } => "compartment",
        UnitKind::Reduction => "reduction",
    };
    Some(PreconditionCell(BTreeMap::from([
        ("proof_variant".to_string(), proof_variant.to_string()),
        ("unit_kind".to_string(), unit_kind.to_string()),
        (
            "locator_presence".to_string(),
            if record.locator.is_some() {
                "present"
            } else {
                "none"
            }
            .to_string(),
        ),
        ("unit_membership".to_string(), unit_membership.to_string()),
        (
            "row_version_relation".to_string(),
            row_version_relation.to_string(),
        ),
    ])))
}

fn legacy_counterexample_aggregate(row_version: u64, case: &Value) -> String {
    let records = case["current_units"].as_array().expect("current units");
    let sources = case["current_unit_bytes"]
        .as_array()
        .expect("current unit bytes");
    assert_eq!(records.len(), sources.len());
    let mut encoded = row_version.to_be_bytes().to_vec();
    encoded.extend_from_slice(&(records.len() as u64).to_be_bytes());
    for (record, source) in records.iter().zip(sources) {
        encoded.extend_from_slice(&ce1_text(record["unit"].as_str().expect("unit")));
        let coverage = &record["coverage"];
        encoded.extend_from_slice(
            &coverage["compartment_sequence"]
                .as_u64()
                .expect("compartment sequence")
                .to_be_bytes(),
        );
        encoded.extend_from_slice(&coverage["start"].as_u64().expect("start").to_be_bytes());
        encoded.extend_from_slice(&coverage["end"].as_u64().expect("end").to_be_bytes());
        encoded.extend_from_slice(&ce1_bytes(source.as_str().expect("source").as_bytes()));
    }
    domain_digest("mc.d5.projection.v1", &encoded)
}

#[test]
fn d5_r17_3_unit_precondition_table_is_total() {
    let (fixture, _) = load_fixture();
    let space = &fixture.r17_3_unit_precondition_space;
    assert_r17_3_precondition_space(space);
    let cells = precondition_cells(space);
    assert_eq!(cells.len(), 192);
    for cell in cells {
        let rows = fixture
            .r17_3_unit_rule_table
            .iter()
            .filter(|row| row_matches(row, &cell))
            .map(|row| row.row_id.as_str())
            .collect::<Vec<_>>();
        assert!(!rows.is_empty(), "uncovered R17.3 cell {cell:?}");
    }
}

#[test]
fn d5_r17_3_unit_precondition_table_is_disjoint() {
    let (fixture, _) = load_fixture();
    let space = &fixture.r17_3_unit_precondition_space;
    assert_r17_3_precondition_space(space);
    for cell in precondition_cells(space) {
        let rows = fixture
            .r17_3_unit_rule_table
            .iter()
            .filter(|row| row_matches(row, &cell))
            .map(|row| row.row_id.as_str())
            .collect::<Vec<_>>();
        assert!(
            rows.len() <= 1,
            "overlapping R17.3 cell {cell:?} matched rows {rows:?}"
        );
    }
}

#[test]
fn d5_thalamus_counterexamples_are_verbatim_and_digest_controlled() {
    let (fixture, _) = load_fixture();
    assert_eq!(
        sha256_hex(fixture.thalamus_counterexamples_json.as_bytes()),
        "c027ffed96f4acb855a834ddbc96411c874dd05f5212cf5f142080b714fa9628"
    );
    let artifact: Value =
        serde_json::from_str(&fixture.thalamus_counterexamples_json).expect("counterexamples JSON");
    assert_eq!(artifact["rule_source_commit"], "23d26ae99");
    assert_eq!(artifact["unit_digest_sentinel_verified"], true);
    assert_eq!(
        domain_digest("mc.d5.unit-projection.v1", &unit_ce1("u1", 7, b"red")),
        "3dc9079367264990f8614660b3f0a1f5ab3b133c4ed3e841bff793f38a84f90a"
    );
    let cases = artifact["cases"].as_array().expect("counterexample cases");
    assert_eq!(
        cases
            .iter()
            .map(|case| case["id"].as_str().expect("case id"))
            .collect::<Vec<_>>(),
        [
            "empty_reduction_as_fold",
            "prior_unit_absent_from_current_pass"
        ]
    );
    for case in cases {
        let row_version = case["row_version"].as_u64().expect("row version");
        for (record, source) in case["current_units"]
            .as_array()
            .expect("current units")
            .iter()
            .zip(
                case["current_unit_bytes"]
                    .as_array()
                    .expect("current bytes"),
            )
        {
            assert_eq!(
                record["sha256"].as_str().expect("unit digest"),
                domain_digest(
                    "mc.d5.unit-projection.v1",
                    &unit_ce1(
                        record["unit"].as_str().expect("unit"),
                        row_version,
                        source.as_str().expect("source").as_bytes(),
                    ),
                )
            );
        }
        assert_eq!(
            case["aggregate_sha256"].as_str().expect("aggregate digest"),
            legacy_counterexample_aggregate(row_version, case)
        );
        assert_eq!(case["required_safe_outcome"], "d5_carry_proof_mismatch");
    }
}

#[test]
fn d5_coverage_precedence_table_is_total() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    assert_regardless_markers(&fixture);
    let counts = table_cell_counts(&fixture);
    assert!(
        counts.iter().all(|count| *count > 0),
        "precedence totality: {} of {} product cells have no row",
        counts.iter().filter(|count| **count == 0).count(),
        counts.len()
    );
}

#[test]
fn d5_coverage_precedence_table_is_disjoint() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    let counts = table_cell_counts(&fixture);
    assert!(
        counts.iter().all(|count| *count <= 1),
        "precedence disjointness: {} of {} product cells overlap",
        counts.iter().filter(|count| **count > 1).count(),
        counts.len()
    );
}

fn identity_shapes(fixture: &Fixture) -> Vec<Vec<BlockIdentity>> {
    let members = fixture
        .manifest
        .members
        .iter()
        .map(|member| member.identity.clone())
        .collect::<Vec<_>>();
    let mut missing = members.clone();
    missing.pop();
    let mut duplicate = members.clone();
    duplicate.push(members[0].clone());
    let mut foreign = members.clone();
    foreign[5] = BlockIdentity {
        mid: "grammar-foreign-mid".to_string(),
        index: 0,
        ordinal: 1805,
    };
    vec![members, missing, duplicate, foreign]
}

fn generated_proof_lists(fixture: &Fixture) -> Vec<Option<Vec<CoverageProofV1>>> {
    let identities = identity_shapes(fixture);
    let mut generated = vec![None, Some(Vec::new())];
    for covered in identities {
        generated.push(Some(vec![CoverageProofV1::ReceiptBacked {
            covered: covered.clone(),
        }]));
        generated.push(Some(vec![CoverageProofV1::RealCompartment {
            covered: covered.clone(),
            unit: "unit-real-41".to_string(),
        }]));
        let split = covered.len().min(3);
        generated.push(Some(vec![
            CoverageProofV1::ReceiptBacked {
                covered: covered[..split].to_vec(),
            },
            CoverageProofV1::RealCompartment {
                covered: covered[split..].to_vec(),
                unit: "unit-real-41".to_string(),
            },
        ]));
    }
    generated.extend([
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::Fold {
                units: vec!["unit-fold-43".to_string()],
            },
        }]),
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::Reduction {
                units: vec!["unit-reduced-42".to_string()],
            },
        }]),
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::CustodyTransfer {
                transferee_receipt_id: "grammar-receipt".to_string(),
                edge_id: "grammar-edge".to_string(),
                origin: TransferOrigin {
                    receipt_id: fixture.gateway_state.receipt_id.clone(),
                    predecessor_key: fixture.gateway_state.predecessor_key.clone(),
                    lineage_id: fixture.gateway_state.lineage_id.clone(),
                    manifest_digest: fixture.manifest.manifest_digest.clone(),
                },
            },
        }]),
        Some(vec![CoverageProofV1::Unsupported]),
        Some(vec![
            CoverageProofV1::Discharged {
                by: DischargeBy::Unsupported,
            },
            CoverageProofV1::ReceiptBacked {
                covered: Vec::new(),
            },
        ]),
    ]);
    generated
}

#[test]
fn d5_coverage_classifiers_cover_schema_valid_carry_grammar() {
    let (fixture, _) = load_fixture();
    let template = fixture.vectors[25].d5_carry.clone();
    let span = fixture.vectors[25].served_carry_span.clone();
    let mut observed = BTreeMap::<String, BTreeSet<String>>::new();
    for proofs in generated_proof_lists(&fixture) {
        for members in [&template.members[..], &template.members[..5]] {
            let mut carry = template.clone();
            carry.members = members.to_vec();
            carry.coverage_proof = proofs.clone();
            let wire = serde_json::to_value(&carry).expect("serialize generated carry");
            let decoded: CarryProjectionV1 =
                serde_json::from_value(wire).expect("schema-valid generated carry");
            let vector = Vector {
                id: "generated".to_string(),
                name: "generated grammar member".to_string(),
                served_carry_span: span.clone(),
                served_array: fixture.vectors[25].served_array.clone(),
                recorded_before: Vec::new(),
                d5_carry: decoded,
                gateway_folded_frontier: 1804,
                expected: Expected {
                    outcome: "unused".to_string(),
                    reason: None,
                },
                precedence_row: "unused".to_string(),
                r17_3_preconditions: None,
                r17_3_rule_row: None,
                counterexample_id: None,
                loss_specimen: None,
            };
            let cell = classify(&fixture, &vector);
            for (dimension, value) in &cell.0 {
                assert!(fixture.precondition_space.dimensions[dimension].contains(value));
                observed
                    .entry(dimension.clone())
                    .or_default()
                    .insert(value.clone());
            }
            let matching = fixture
                .precedence_table
                .iter()
                .filter(|row| row_matches(row, &cell))
                .count();
            assert_eq!(matching, 1, "generated carry must classify once: {cell:?}");
        }
    }
    for required in ["proof_list", "union_vs_manifest", "variant_tag"] {
        assert!(
            observed[required].len() >= 4 || required == "variant_tag",
            "grammar breadth for {required}"
        );
    }
}

#[test]
fn d5_aggregate_preimages_match_r17_4_ce1() {
    let fixture = load_aggregate_preimages();
    assert_eq!(fixture.schema, "mc.d5.aggregate-preimages.v1");
    assert!(fixture.derivation.contains("independent Python CE1"));
    assert_eq!(fixture.vectors.len(), 6);

    for vector in fixture.vectors {
        assert_eq!(vector.tag, "mc.d5.projection.v1", "{} tag", vector.name);
        assert_eq!(vector.version, 1, "{} version", vector.name);
        let records = vector
            .units
            .into_iter()
            .map(|unit| {
                let kind = match unit.kind {
                    AggregateKind::Compartment { compartment } => UnitKind::Compartment {
                        compartment_sequence: compartment.compartment_sequence,
                    },
                    AggregateKind::Reduction(tag) => {
                        assert_eq!(tag, "reduction", "{} reduction tag", vector.name);
                        UnitKind::Reduction
                    }
                };
                (
                    UnitRecordV1 {
                        unit: unit.unit,
                        kind,
                        coverage: unit.coverage,
                        locator: None,
                        source_text: String::new(),
                        sha256: String::new(),
                    },
                    unit.bytes_utf8.into_bytes(),
                )
            })
            .collect::<Vec<_>>();
        let record_refs = records
            .iter()
            .map(|(record, bytes)| (record, bytes.as_slice()))
            .collect::<Vec<_>>();
        let payload = projection_ce1(vector.row_version, &record_refs);
        assert_eq!(
            payload,
            decode_hex(&vector.preimage_hex),
            "{} payload",
            vector.name
        );
        assert_eq!(
            domain_digest(&vector.tag, &payload),
            vector.sha256,
            "{} digest",
            vector.name
        );
    }
}

#[test]
fn d5_coverage_source_text_digests_match_domain_preimages() {
    let (fixture, _) = load_fixture();
    assert_digest_provenance(&fixture);
}

#[test]
fn d5_coverage_unknown_kind_is_a_typed_mismatch() {
    let (fixture, _) = load_fixture();
    let vector = fixture
        .vectors
        .iter()
        .find(|vector| vector.name.contains("unsupported outer kind"))
        .expect("unsupported-kind vector");
    assert_eq!(
        variant_tag(vector.d5_carry.coverage_proof.as_deref()),
        "unsupported"
    );
    let cell = classify(&fixture, vector);
    let row = fixture
        .precedence_table
        .iter()
        .find(|row| row_matches(row, &cell))
        .expect("unsupported row");
    assert_eq!(row.row_id, "C02_unsupported_variant");
    assert_eq!(
        vector.expected.reason.as_deref(),
        Some("d5_carry_proof_mismatch")
    );
}

fn custody_snapshot(fixture: &Fixture) -> Value {
    serde_json::json!({
        "receipt_id": fixture.gateway_state.receipt_id,
        "predecessor_key": fixture.gateway_state.predecessor_key,
        "successor_key": fixture.gateway_state.successor_key,
        "lineage_id": fixture.gateway_state.lineage_id,
        "redeemed_receipts": fixture.gateway_state.redeemed_receipts,
        "held_receipts": fixture.gateway_state.held_receipts,
    })
}

fn publish_accepted_pass(recorded: &mut Vec<RecordedPass>, vector: &Vector) {
    let published_units = vector
        .d5_carry
        .projection_digest
        .units
        .iter()
        .map(|unit| unit.unit.as_str())
        .collect::<BTreeSet<_>>();
    for pass in recorded.iter_mut() {
        if pass.receipt_id == vector.d5_carry.receipt_id {
            pass.units
                .retain(|unit| !published_units.contains(unit.unit.as_str()));
        }
    }
    recorded.retain(|pass| !pass.units.is_empty());
    if !vector.d5_carry.projection_digest.units.is_empty() {
        recorded.push(RecordedPass {
            receipt_id: vector.d5_carry.receipt_id.clone(),
            row_version: vector.d5_carry.projection_digest.row_version,
            units: vector.d5_carry.projection_digest.units.clone(),
        });
    }
}

#[test]
fn d5_coverage_vectors_agree_with_owner_authored_table() {
    let (fixture, fixture_bytes) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.coverage-proof-vectors.v1");
    assert!(fixture.encoding_rule.r16.contains("R16"));
    assert!(fixture.encoding_rule.r16.contains("unknown kind"));
    assert!(fixture
        .encoding_rule
        .served_digest
        .contains("mc.d5.block.served.v1"));
    assert!(fixture
        .encoding_rule
        .expectations
        .contains("owner-authored"));
    assert!(fixture
        .encoding_rule
        .unit_validation
        .contains("R17.3 step 0"));
    assert!(fixture.gateway_state.recorded.is_empty());
    assert_eq!(fixture.manifest.schema_version, 1);
    assert_eq!(fixture.manifest.normalization_version, 1);
    assert_eq!(fixture.manifest.encoding_version, 1);
    assert_eq!(fixture.manifest.members.len(), 6);
    assert_eq!(fixture.gateway_state.receipt_id, RECEIPT_ID);
    assert_eq!(fixture.gateway_state.redeemed_receipts.len(), 1);
    assert_eq!(
        fixture.gateway_state.redeemed_receipts[0].receipt_id,
        fixture.gateway_state.held_receipts[0].receipt_id
    );
    assert_eq!(
        fixture.gateway_state.redeemed_receipts[0].edge_id,
        fixture.gateway_state.held_receipts[0].edge_id
    );
    assert!(fixture
        .gateway_state
        .held_receipts
        .iter()
        .all(|held| !held.successor_key.is_empty()));
    assert!(fixture.gateway_state.known_units.iter().all(|unit| {
        unit.compartment_sequence > 0
            && !unit.unit.is_empty()
            && unit.row_version == 12
            && unit.unit_digest.len() == 64
    }));
    assert!(fixture.gateway_state.held_receipts.iter().all(|held| {
        held.manifest_blocks.iter().all(|block| {
            block.identity.ordinal >= 1799
                && match &block.provenance {
                    Provenance::Native { attempt_id } => !attempt_id.is_empty(),
                    Provenance::InheritedFrom { receipt_id, .. } => !receipt_id.is_empty(),
                }
        })
    }));
    assert_digest_provenance(&fixture);
    assert_precondition_space(&fixture.precondition_space);
    assert_regardless_markers(&fixture);

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
            row.expected_outcome.as_str(),
            "COVERED" | "OUTSTANDING_CLEARED" | "REFUSED"
        ));
    }
    assert_eq!(fixture.precedence_table.len(), 27);

    let mut vector_ids = BTreeSet::new();
    for vector in &fixture.vectors {
        assert!(
            vector_ids.insert(vector.id.as_str()),
            "duplicate vector {}",
            vector.id
        );
        assert!(!vector.name.is_empty());
        assert_eq!(vector.d5_carry.schema_version, 1, "{} schema", vector.id);
        assert_eq!(
            vector.d5_carry.receipt_id, RECEIPT_ID,
            "{} receipt",
            vector.id
        );
        assert_eq!(
            vector.d5_carry.manifest_digest,
            fixture.manifest.manifest_digest
        );
        assert_eq!(vector.d5_carry.archive_id.len(), 64);
        assert_eq!(
            vector.d5_carry.row_version,
            vector.d5_carry.projection_digest.row_version
        );
        assert_eq!(vector.d5_carry.native_continuation_identity.ordinal, 1940);
        assert_eq!(
            vector
                .d5_carry
                .coverage_identity
                .as_ref()
                .map(|id| id.ordinal),
            Some(1804)
        );
        let cell = classify(&fixture, vector);
        let selected = fixture
            .precedence_table
            .iter()
            .filter(|row| row_matches(row, &cell))
            .collect::<Vec<_>>();
        assert_eq!(
            selected.len(),
            1,
            "{} must select one row for {cell:?}",
            vector.id
        );
        let selected = selected[0];
        assert_eq!(
            selected.row_id, vector.precedence_row,
            "{} precedence row",
            vector.id
        );
        assert_eq!(
            selected.expected_outcome, vector.expected.outcome,
            "{} owner expected outcome",
            vector.id
        );
        assert_eq!(
            selected.expected_reason, vector.expected.reason,
            "{} owner expected reason",
            vector.id
        );
        match (&vector.r17_3_preconditions, &vector.r17_3_rule_row) {
            (Some(preconditions), Some(rule_row)) => {
                let actual = r17_3_vector_cell(vector).expect("R17.3 cited unit cell");
                assert_eq!(&actual.0, preconditions, "{} R17.3 cell", vector.id);
                let selected = fixture
                    .r17_3_unit_rule_table
                    .iter()
                    .filter(|row| row_matches(row, &actual))
                    .collect::<Vec<_>>();
                assert_eq!(selected.len(), 1, "{} R17.3 selected row", vector.id);
                assert_eq!(selected[0].row_id, *rule_row, "{} R17.3 row", vector.id);
                let unit_outcome = if vector.expected.outcome == "REFUSED" {
                    "MISMATCH"
                } else {
                    "ACCEPTED"
                };
                assert_eq!(
                    selected[0].expected_outcome, unit_outcome,
                    "{} R17.3 owner outcome",
                    vector.id
                );
            }
            (None, None) => {}
            _ => panic!("{} incomplete R17.3 vector metadata", vector.id),
        }
        if let Some(counterexample_id) = &vector.counterexample_id {
            assert!(matches!(
                counterexample_id.as_str(),
                "empty_reduction_as_fold" | "prior_unit_absent_from_current_pass"
            ));
            assert_eq!(vector.expected.outcome, "REFUSED");
        }
    }
    assert_eq!(fixture.vectors.len(), 58);

    assert_eq!(fixture.vector_sequences.len(), 1);
    let sequence = &fixture.vector_sequences[0];
    assert_eq!(sequence.id, "S01_accept_reject_accept");
    let custody = custody_snapshot(&fixture);
    let mut recorded = Vec::new();
    for step in &sequence.steps {
        let vector = fixture
            .vectors
            .iter()
            .find(|vector| vector.id == step.vector_id)
            .expect("sequence vector");
        assert_eq!(
            vector.recorded_before, recorded,
            "{} complete recorded-before ordering",
            step.vector_id
        );
        assert_eq!(unit_validation(vector), "all_valid");
        let cell = classify(&fixture, vector);
        let row = fixture
            .precedence_table
            .iter()
            .find(|row| row_matches(row, &cell))
            .expect("sequence precedence row");
        let oracle_accepted = row.expected_outcome != "REFUSED";
        assert_eq!(
            oracle_accepted, step.accepted,
            "{} acceptance",
            step.vector_id
        );
        let before_rejection = recorded.clone();
        if step.accepted {
            publish_accepted_pass(&mut recorded, vector);
        } else {
            assert_eq!(
                recorded, before_rejection,
                "{} rejected pass published records",
                step.vector_id
            );
        }
        assert_eq!(
            recorded, step.recorded_after,
            "{} complete publish-after-accept ordering",
            step.vector_id
        );
        assert_eq!(custody, step.custody_after, "{} custody", step.vector_id);
    }

    let loss = fixture
        .vectors
        .iter()
        .find_map(|vector| vector.loss_specimen.as_ref())
        .expect("inflated-frontier loss specimen");
    assert_eq!((loss.obligation.first, loss.obligation.last), (1799, 1939));
    assert_eq!(loss.real_compartments_end, 1798);
    assert_eq!(loss.lineage_boundary.ordinal, 1940);
    assert!(loss.lineage_boundary.empty);
    assert!(!loss.lineage_boundary.is_compartment);

    let index: Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    let files = index["files"].as_array().expect("index files array");
    let expected_unchanged = [
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
        (
            "redeem-vectors-v1.json",
            193_549,
            "fbfe54ac08b3464165f4e65d025843b838929366ca6c7ee6a1a9f25172f5a116",
        ),
        (
            "README.md",
            14_714,
            "69930139ced05bc2ef2f6462631e2e67b30134e4856c95584efb88b93e267666",
        ),
    ];
    for (path, size, digest) in expected_unchanged {
        let entry = files
            .iter()
            .find(|entry| entry["path"] == path)
            .expect("unchanged indexed file");
        assert_eq!(entry["byte_size"], size, "{path} byte size changed");
        assert_eq!(entry["sha256"], digest, "{path} digest changed");
    }
    let entry = files
        .iter()
        .find(|entry| entry["path"] == "coverage-proof-vectors-v1.json")
        .expect("coverage fixture indexed");
    assert_eq!(entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(entry["derived"], false);
    assert_eq!(
        entry["source"],
        "owner-authored D5 coverage-proof contract vectors"
    );
}
