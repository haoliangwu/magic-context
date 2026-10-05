//! Probes that are deliberately written against the pre-A1 API surface so the
//! SAME file compiles and runs on the base commit `991046ca` as well as here.
//!
//! The acceptance bar for the host-runner slice was "with the default runner,
//! nothing changed". The historian's calibration examples now intentionally use
//! three seeds plus diverse older and recent session references, so its request
//! digest is pinned to the current prompt while the served-byte digest remains
//! the base-tree comparison.
//!
//! - The historian request digest covers exactly what leaves the module for the
//!   completion provider: the system prompt, the user prompt, and the model.
//! - The served digest covers what the harness receives back from a fold pass.
//! - The meta digest covers the durable session blob, which is the one stream
//!   the slice DOES change (it gains an attempt field) and therefore has to be
//!   measured rather than assumed.
//!
//! Only the first two are asserted against pinned values. The meta digest is
//! reported, because its whole point is that it differs between the two trees.

use super::*;
use sha2::{Digest, Sha256};

/// The historian request bytes pinned after calibration switched to three seeds
/// plus diverse older and recent session examples. Main-session bytes stay pinned
/// separately by BASELINE_SERVED_DIGEST.
const EXPECTED_REQUEST_DIGEST: &str =
    "a2e70c1e70fd85b1b442c69a6e312a3595b2f97953f2de01ab64b892dd914320";

/// The array a fold pass serves, recorded the same way.
const BASELINE_SERVED_DIGEST: &str =
    "34e55f759e321821f452bf6e028cfe94eef25c5087afac4345480b419863b680";

/// The durable session blob on the base tree. This one is NOT expected to match
/// here: the slice adds an attempt field to every blob. It is pinned so the
/// difference stays exactly that one known field instead of becoming a licence
/// to reshape the blob.
///
/// Re-recorded against master at `981c746b` when the slice was integrated there:
/// master's own later work had already grown the blob from the 22,027 bytes
/// recorded at `991046ca`. The request digest above tracks the current shared
/// historian prompt; the served digest below remains the base-tree comparison.
const BASELINE_META_DIGEST: &str =
    "6d9f28bd0253565e8175ad3d26a4f7e490b01d577f188c8299b0321ee502caeb";
// One byte more than the base tree's 22_403: the single-store move folds two more
// inputs into `m1_external_revision`, and the hash it stores here is one decimal digit
// longer. Nothing about the attempt field changed.
const BASELINE_META_BYTES: usize = 22_404;
const ATTEMPT_FIELD: &str = ",\"producer_attempt\":0";

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        // A separator no prompt can contain, so two different splits of the same
        // concatenated text cannot collide into one digest.
        hasher.update([0u8]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Drive one real fold through the default (in-module) runner and report the
/// digest of the completion request it sent, plus the durable meta blob.
#[tokio::test(flavor = "current_thread")]
async fn gate_probe_default_runner_request_and_meta_digests() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::clone(&producer), default_test_config());

    let fired = call_transform(&handler, big_messages()).await;
    assert_eq!(fired["historian"]["fired"], true, "{fired}");
    wait_for_count(&producer.starts, 1).await;
    wait_for_idle(&store).await;

    let systems = producer.systems.lock().unwrap().clone();
    let prompts = producer.prompts.lock().unwrap().clone();
    let models = producer.models.lock().unwrap().clone();
    assert_eq!(systems.len(), 1, "exactly one completion was requested");

    let parts: Vec<&str> = systems
        .iter()
        .chain(prompts.iter())
        .chain(models.iter())
        .map(String::as_str)
        .collect();
    let request_digest = digest(&parts);

    // The provider session id carries a hash of the project root, which is a
    // temp directory, so it is reported in shape rather than hashed.
    let sessions = producer.sessions.lock().unwrap().clone();
    let session_shape = sessions
        .iter()
        .map(|session| {
            let mut fields: Vec<&str> = session.split(':').collect();
            // Only the middle field (the project hash) is path-dependent.
            if fields.len() == 4 {
                fields[2] = "<project-hash>";
            }
            fields.join(":")
        })
        .collect::<Vec<_>>()
        .join(",");

    let meta_blob = serde_json::to_string(&store.load("ses").unwrap().meta).unwrap();
    let meta_digest = digest(&[&meta_blob]);

    println!("GATE-PROBE request_digest={request_digest}");
    println!("GATE-PROBE system_bytes={}", systems[0].len());
    println!("GATE-PROBE prompt_bytes={}", prompts[0].len());
    println!("GATE-PROBE model={}", models[0]);
    println!("GATE-PROBE session_shape={session_shape}");
    println!("GATE-PROBE meta_digest={meta_digest}");
    println!("GATE-PROBE meta_bytes={}", meta_blob.len());
    println!(
        "GATE-PROBE meta_has_producer_attempt={}",
        meta_blob.contains("\"producer_attempt\"")
    );

    assert_eq!(
        request_digest, EXPECTED_REQUEST_DIGEST,
        "the default runner's completion request must match its pinned prompt bytes"
    );

    // The durable blob is the one stream that does move, and it moves by exactly
    // the width of the new attempt field. Anything else touching the blob shows up
    // here as a length that is neither the base's nor the base's plus that field.
    assert_ne!(
        meta_digest, BASELINE_META_DIGEST,
        "the attempt is stored unconditionally, so the blob cannot match the base's"
    );
    assert!(
        meta_blob.contains(ATTEMPT_FIELD),
        "the attempt rides the blob as a plain field: {meta_blob:.200}"
    );
    assert_eq!(
        meta_blob.len(),
        BASELINE_META_BYTES + ATTEMPT_FIELD.len(),
        "the blob must grow by exactly the new field and nothing else"
    );
}

/// The bytes the harness is served on the pass that folds. This is the other
/// half of "no behaviour change": the request going out AND the array coming
/// back.
#[tokio::test(flavor = "current_thread")]
async fn gate_probe_served_bytes_digest_across_a_fold() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::clone(&producer), default_test_config());

    let first = call_transform(&handler, big_messages()).await;
    assert_eq!(first["historian"]["fired"], true, "{first}");
    wait_for_count(&producer.starts, 1).await;
    wait_for_idle(&store).await;

    let folded = call_transform(&handler, big_messages()).await;
    let served = serde_json::to_string(&folded["ck_messages"]).unwrap();
    let served_digest = digest(&[&served]);
    println!("GATE-PROBE served_digest={served_digest}");
    println!("GATE-PROBE served_bytes={}", served.len());
    println!(
        "GATE-PROBE compartments={}",
        store.load_compartments("ses").unwrap().len()
    );
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        1,
        "the pass under test has to be one that serves a published fold"
    );
    assert_eq!(
        served_digest, BASELINE_SERVED_DIGEST,
        "a fold pass must serve the same array it served on the base tree"
    );
}
