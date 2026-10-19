use std::path::Path;

pub fn available(workspace: &Path) -> bool {
    let sibling = workspace
        .parent()
        .expect("workspace has a parent")
        .join("subconscious");
    if sibling.join("Cargo.toml").is_file() {
        true
    } else {
        eprintln!(
            "SKIP real-daemon test: sibling subconscious checkout is missing at {}",
            sibling.display()
        );
        false
    }
}

#[test]
fn missing_checkout_skips_but_a_present_checkout_runs() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("magic-context");
    std::fs::create_dir(&workspace).unwrap();
    assert!(!available(&workspace));
    let sibling = root.path().join("subconscious");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("Cargo.toml"), "[workspace]\n").unwrap();
    assert!(available(&workspace));
}
