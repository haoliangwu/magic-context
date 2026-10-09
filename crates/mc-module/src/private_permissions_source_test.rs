use std::fs;
use std::path::{Path, PathBuf};

use quote::ToTokens;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, ExprCall, ExprMethodCall, ImplItemFn, Item, ItemFn, ItemMod};

#[derive(Default)]
struct DirectCreatorScan {
    calls: Vec<String>,
}

fn cfg_test(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attribute| {
        let tokens = attribute.meta.to_token_stream().to_string();
        attribute.path().is_ident("test")
            || (attribute.path().is_ident("cfg") && tokens.contains("test"))
    })
}

impl<'ast> Visit<'ast> for DirectCreatorScan {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_item_mod(self, item);
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_item_fn(self, item);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_impl_item_fn(self, item);
    }

    fn visit_expr_call(&mut self, call: &'ast ExprCall) {
        if let Expr::Path(path) = call.func.as_ref() {
            let names = path
                .path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>();
            let last = names.last().map(String::as_str).unwrap_or_default();
            let filesystem_path = names.first().is_some_and(|first| first == "fs")
                || names.starts_with(&["std".to_string(), "fs".to_string()]);
            if filesystem_path && matches!(last, "create_dir" | "create_dir_all" | "write")
                || (last == "create" && names.iter().any(|name| name == "File"))
            {
                self.calls.push(names.join("::"));
            }
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_expr_method_call(&mut self, call: &'ast ExprMethodCall) {
        if matches!(call.method.to_string().as_str(), "create" | "create_new") {
            self.calls
                .push(format!("file-creator::{method}", method = call.method));
        }
        visit::visit_expr_method_call(self, call);
    }
}

fn rust_sources(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "tests") {
                continue;
            }
            rust_sources(&path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs")
            && !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains("test"))
        {
            output.push(path);
        }
    }
}

#[test]
fn data_store_creators_use_the_private_permission_helper() {
    let mc_module = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mc_store = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mc-store/src");
    let dashboard =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/dashboard/src-tauri/src");
    let mut sources = Vec::new();
    for root in [&mc_module, &mc_store, &dashboard] {
        rust_sources(root, &mut sources);
    }

    let mut offenders = Vec::new();
    for path in sources {
        // These files are themselves permission helpers. Dashboard config is a
        // separate atomic config writer whose OpenOptionsExt mode is applied at create.
        if path.ends_with("mc-store/src/private_permissions.rs")
            || path.ends_with("packages/dashboard/src-tauri/src/config.rs")
        {
            continue;
        }
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let calls = direct_store_creators(&source);
        if !calls.is_empty() {
            offenders.push(format!("{}: {}", path.display(), calls.join(", ")));
        }
    }

    assert!(
        offenders.is_empty(),
        "direct store creators bypass helper: {offenders:#?}"
    );
}

/// The direct filesystem creators in one storage-related source file, outside
/// test code. A file that names no store location is not scanned.
fn direct_store_creators(source: &str) -> Vec<String> {
    if ![
        "context.db",
        "store.db",
        "backup_dir",
        "storage_dir",
        "project-identities",
    ]
    .iter()
    .any(|marker| source.contains(marker))
    {
        return Vec::new();
    }
    let Ok(parsed) = syn::parse_file(source) else {
        return Vec::new();
    };
    let mut scan = DirectCreatorScan::default();
    for item in &parsed.items {
        if let Item::Mod(module) = item {
            if cfg_test(&module.attrs) {
                continue;
            }
        }
        scan.visit_item(item);
    }
    scan.calls
}

/// The shipped sources hold no violation, so the scan above would pass even if
/// it could no longer see one. This planted file proves it still flags every
/// kind of direct creator, and still ignores the same calls in test code.
#[test]
fn the_creator_scan_flags_planted_direct_store_creators() {
    let planted = r#"
        const STORE: &str = "context.db";
        fn open_store(dir: &std::path::Path) {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(STORE), b"").unwrap();
            let _ = std::fs::File::create(dir.join("store.db"));
            let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(dir);
        }
        #[cfg(test)]
        mod tests {
            fn fixture() {
                std::fs::write("context.db", b"").unwrap();
            }
        }
    "#;
    assert_eq!(
        direct_store_creators(planted),
        vec![
            "std::fs::create_dir_all".to_string(),
            "std::fs::write".to_string(),
            "std::fs::File::create".to_string(),
            "file-creator::create_new".to_string(),
        ],
        "the scan must flag each planted direct creator and nothing in test code"
    );
}
