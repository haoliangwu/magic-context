use std::fs;
use std::process::Command;

#[test]
fn module_start_writes_dated_segment_under_resolved_data_dir() {
    let root = tempfile::tempdir().expect("temp data home");
    let output = Command::new(env!("CARGO_BIN_EXE_ck-mc"))
        .env("XDG_DATA_HOME", root.path())
        .env("SUBC_MODULE_ID", "magic-context")
        .env("CK_LOG", "info")
        .arg("--subc")
        .arg(root.path().join("missing-connection-file"))
        .output()
        .expect("start module");
    assert!(
        !output.status.success(),
        "missing connection file must fail startup"
    );
    let logs = root.path().join("cortexkit/magic-context/logs");
    let entries: Vec<_> = fs::read_dir(&logs)
        .expect("module log directory")
        .map(|entry| entry.expect("segment entry").path())
        .collect();
    assert_eq!(entries.len(), 1);
    let filename = entries[0].file_name().unwrap().to_string_lossy();
    assert!(filename.starts_with("magic-context.20") && filename.ends_with(".log"));
    let line = fs::read_to_string(&entries[0]).expect("segment content");
    assert!(
        line.contains(" INFO  magic-context: mc-module: logger initialized"),
        "{line}"
    );
}
