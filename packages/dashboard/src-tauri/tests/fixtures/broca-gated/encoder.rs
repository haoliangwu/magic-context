// Run as the main.rs of a temporary Cargo package with broca-wal pinned to
// b421d13142ed3206f6d7d9ac9d1708c4f70a7e4d. No provider or session content is used.
use broca_wal::{framing, WalRecord};
fn main() {
    let record: WalRecord = serde_json::from_str(r#"{"type":"turn_finished","step_id":1}"#).unwrap();
    let mut bytes = framing::encode(1, 7, &record).unwrap();
    bytes.extend(framing::encode_with_requires(2, 7, framing::KNOWN_FEATURES, &record).unwrap());
    std::fs::write(std::env::args().nth(1).unwrap(), bytes).unwrap();
}
