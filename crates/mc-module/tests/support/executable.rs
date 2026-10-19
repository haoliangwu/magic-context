use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

const FALLBACK_EXECUTABLE_ROOT: &str = "/tmp/magic-context-exec";

fn executable_root() -> PathBuf {
    let tmp_dir = std::env::var_os("TMPDIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let resolved_tmp_dir = tmp_dir
        .as_deref()
        .and_then(|path| fs::canonicalize(path).ok());
    executable_root_for_tmpdir(tmp_dir.as_deref(), resolved_tmp_dir.as_deref())
}

/// Selects TMPDIR only when its resolved path is not macOS's transient folder.
pub fn executable_root_for_tmpdir(
    tmp_dir: Option<&Path>,
    resolved_tmp_dir: Option<&Path>,
) -> PathBuf {
    let (Some(tmp_dir), Some(resolved_tmp_dir)) = (tmp_dir, resolved_tmp_dir) else {
        return PathBuf::from(FALLBACK_EXECUTABLE_ROOT);
    };

    if [Path::new("/var/folders"), Path::new("/private/var/folders")]
        .iter()
        .any(|prefix| resolved_tmp_dir == *prefix || resolved_tmp_dir.starts_with(prefix))
    {
        PathBuf::from(FALLBACK_EXECUTABLE_ROOT)
    } else {
        tmp_dir.join("magic-context-exec")
    }
}

/// Copy a test executable off Cargo's build volume before another process launches it.
pub fn stage_executable(source: &Path, name: &str, identifier: &str) -> io::Result<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    let _ = identifier;

    if Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "staged executable name must be a single path component",
        ));
    }

    let bytes = fs::read(source)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let root = executable_root();
    ensure_private_directory(&root)?;
    let directory = root.join(digest);
    ensure_private_directory(&directory)?;
    let destination = directory.join(name);
    if verified_copy(&destination, &bytes, identifier)? {
        return Ok(destination);
    }

    let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        set_owner_only(&temporary)?;

        #[cfg(target_os = "macos")]
        sign_executable(&temporary, identifier)?;

        set_owner_only(&temporary)?;
        fs::rename(&temporary, &destination)?;

        #[cfg(target_os = "macos")]
        {
            if !verify_signature(&destination, identifier)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "staged executable has an invalid signature: {}",
                        destination.display()
                    ),
                ));
            }
            write_signature_record(&destination, &bytes, identifier)?;
        }

        Ok(destination.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("staging path is not a real directory: {}", path.display()),
        ));
    }
    set_owner_only(path)
}

fn set_owner_only(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn verified_copy(destination: &Path, source_bytes: &[u8], _identifier: &str) -> io::Result<bool> {
    let Ok(metadata) = fs::symlink_metadata(destination) else {
        return Ok(false);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Ok(false);
        }
    }

    let staged_bytes = fs::read(destination)?;
    #[cfg(target_os = "macos")]
    {
        let sidecar = destination.with_file_name(format!(
            ".{}.sha256",
            destination.file_name().unwrap().to_string_lossy()
        ));
        let expected_source_hash = format!("{:x}", Sha256::digest(source_bytes));
        let expected_staged_hash = format!("{:x}", Sha256::digest(&staged_bytes));
        let record = match fs::read_to_string(sidecar) {
            Ok(record) => record,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        if record.trim() != format!("{expected_source_hash} {expected_staged_hash} {_identifier}")
            || !verify_signature(destination, _identifier)?
        {
            return Ok(false);
        }
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(staged_bytes == source_bytes)
    }
}

#[cfg(target_os = "macos")]
fn sign_executable(path: &Path, identifier: &str) -> io::Result<()> {
    let output = std::process::Command::new("codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--options",
            "runtime",
            "--identifier",
            identifier,
        ])
        .arg(path)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "codesign failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        )))
    }
}

#[cfg(target_os = "macos")]
fn write_signature_record(path: &Path, source_bytes: &[u8], identifier: &str) -> io::Result<()> {
    let filename = path
        .file_name()
        .expect("staged executable has a filename")
        .to_string_lossy();
    let record = path.with_file_name(format!(".{filename}.sha256"));
    let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_file_name(format!(
        ".{filename}.{}.{}.sha256.tmp",
        std::process::id(),
        sequence
    ));
    let staged_bytes = fs::read(path)?;
    let line = format!(
        "{:x} {:x} {identifier}\n",
        Sha256::digest(source_bytes),
        Sha256::digest(staged_bytes),
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(line.as_bytes())?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, record)
}

#[cfg(target_os = "macos")]
fn verify_signature(path: &Path, identifier: &str) -> io::Result<bool> {
    let verification = std::process::Command::new("codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .output()?;
    if !verification.status.success() {
        return Ok(false);
    }
    let details = std::process::Command::new("codesign")
        .args(["-dv", "--verbose=2"])
        .arg(path)
        .output()?;
    if !details.status.success() {
        return Ok(false);
    }
    let details = format!(
        "{}{}",
        String::from_utf8_lossy(&details.stdout),
        String::from_utf8_lossy(&details.stderr)
    );
    let has_identifier = details
        .lines()
        .any(|line| line.trim() == format!("Identifier={identifier}"));
    let has_hardened_runtime = details.lines().any(|line| {
        line.split_once("flags=")
            .is_some_and(|(_, flags)| flags.contains("runtime"))
    });
    Ok(details.contains("Signature=adhoc") && has_identifier && has_hardened_runtime)
}
