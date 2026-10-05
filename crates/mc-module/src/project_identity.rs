//! The project identity a directory is known by in `context.db`.
//!
//! Memories, notes and every other project-scoped row are keyed by an identity, not by a
//! path: `git:<root commit>` for a git checkout with history, `dir:<md5 prefix of the
//! path>` otherwise. The host computes it in TypeScript
//! (`packages/plugin/src/features/magic-context/memory/project-identity.ts`,
//! `resolveProjectIdentityForSession` with `allowHomeProject` off), and the module has to
//! compute exactly the same value for a route whose session the host never recorded, such
//! as a Claude Code session. This is a port of that function; the golden vectors in the
//! tests below were produced by running it.
//!
//! One deliberate difference: where the host would fall back to a `dir:` identity for a
//! directory it cannot read at all (a path that no longer exists), this refuses. A route
//! keyed on an identity nobody else computes would read an empty memory set and say
//! nothing, so the caller gets an error naming the directory instead.
//!
//! Inside a checkout, only a repository with no commits yet gets a `dir:` identity. When
//! git itself fails (no git binary, a timeout, an ownership refusal, broken metadata) the
//! last `git:` identity known for the directory or an ancestor within the same repository
//! is reused, and otherwise resolution fails with `git_identity_unavailable`, as the host
//! pauses memory features in that case. A `dir:` answer there would key memories under an
//! identity no host computes for that checkout.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long `git rev-list` may take before the probe counts as a transient failure.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a `dir:` answer is trusted before the directory is probed again, so a repository
/// initialized later is picked up. A `git:` answer never changes and is kept for good.
const DIRECTORY_REVALIDATE_AFTER: Duration = Duration::from_secs(5 * 60);

/// Why no identity could be computed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectIdentityError {
    /// The session runs in the user's home directory, or in a checkout whose repository
    /// root is the home directory. The host does not treat either as a project.
    HomeDirectory { directory: String },
    /// The directory cannot be read as a directory (missing, not a directory, no access).
    Unreadable { directory: String, reason: String },
    /// The directory is inside a git checkout, git could not report its root commit for a
    /// reason other than "no commits yet", and no earlier identity for it is known.
    GitUnavailable { directory: String },
}

impl ProjectIdentityError {
    /// The stable code a refusal carries.
    pub fn code(&self) -> &'static str {
        match self {
            Self::HomeDirectory { .. } => "project_identity_home_directory",
            Self::Unreadable { .. } => "project_identity_unreadable",
            // The host's own error class for the same condition.
            Self::GitUnavailable { .. } => "git_identity_unavailable",
        }
    }
}

impl std::fmt::Display for ProjectIdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HomeDirectory { directory } => write!(
                f,
                "{directory} is the home directory (or a checkout rooted there), which Magic Context does not treat as a project"
            ),
            Self::Unreadable { directory, reason } => {
                write!(f, "cannot read project directory {directory}: {reason}")
            }
            Self::GitUnavailable { directory } => write!(
                f,
                "git identity resolution for {directory} is temporarily unavailable; memory features are paused until git access recovers"
            ),
        }
    }
}

impl std::error::Error for ProjectIdentityError {}

/// Node's `path.resolve` for one argument: absolute against the current directory, with
/// `.` and `..` folded lexically and no trailing separator. Symlinks are not followed.
fn node_path_resolve(directory: &Path) -> PathBuf {
    let absolute = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(directory)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
        }
    }
    if resolved.as_os_str().is_empty() {
        resolved.push("/");
    }
    resolved
}

/// The `dir:` identity: the first 12 hex digits of the MD5 of the resolved path's UTF-8.
pub fn directory_fallback(directory: &Path) -> String {
    let canonical = node_path_resolve(directory);
    let hash = mc_store::md5_hex(&canonical.to_string_lossy());
    format!("dir:{}", &hash[..12])
}

fn realpath(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The nearest ancestor (the directory itself included) holding a `.git` entry, resolved
/// through symlinks. A `.git` file counts, which is how worktrees and submodules look.
fn git_root_in_ancestor_chain(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(realpath(&current).unwrap_or_else(|| node_path_resolve(&current)));
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn git_root_directory(canonical: &Path) -> Option<PathBuf> {
    if let Some(root) = git_root_in_ancestor_chain(canonical) {
        return Some(root);
    }
    let real = realpath(canonical)?;
    if real == canonical {
        None
    } else {
        git_root_in_ancestor_chain(&real)
    }
}

/// Run git in `cwd` with the probe's locale and timeout. `None` when git cannot be
/// started, cannot be waited on, or runs past [`GIT_TIMEOUT`].
fn run_git(cwd: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok()
}

/// The root-commit hash of the checkout at `canonical`, or `None` when git cannot give one
/// (no commits, no git binary, a timeout, ownership refusal). With several roots (merged
/// unrelated histories) the lexicographically smallest is taken, as the host does, so the
/// answer does not depend on git's traversal order.
fn git_root_commit(canonical: &Path) -> Option<String> {
    let output = run_git(canonical, &["rev-list", "--max-parents=0", "HEAD"])?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(|line| line.trim().chars().take(64).collect::<String>())
        .filter(|line| {
            (7..=64).contains(&line.len())
                && line
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .min()
}

/// Whether `canonical` is a readable repository whose HEAD has no commit yet, the one git
/// failure the host answers with a `dir:` identity. The host's test (`hasUnbornHead`):
/// `git rev-parse --git-dir` succeeds, and `git rev-parse --verify --quiet HEAD` exits 1
/// with nothing on stderr. Any other failure (no git, a timeout, an ownership refusal,
/// broken metadata) is not "no commits".
fn has_unborn_head(canonical: &Path) -> bool {
    if !run_git(canonical, &["rev-parse", "--git-dir"])
        .is_some_and(|output| output.status.success())
    {
        return false;
    }
    run_git(canonical, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .is_some_and(|output| output.status.code() == Some(1) && output.stderr.is_empty())
}

/// The host's `projectDirectoryKey`: the spelling a directory is filed under in the
/// remembered-identity sidecars. A Windows-shaped path (drive letter or UNC) has its
/// separators unified, its long-path prefix dropped, `.` and `..` folded, its trailing
/// separator removed and its case lowered; any other path is resolved like Node's
/// `path.resolve`.
fn project_directory_key(directory: &Path) -> String {
    let raw = directory.to_string_lossy();
    let slashed = raw.replace('\\', "/");
    let slashed = if slashed.len() >= 8 && slashed[..8].eq_ignore_ascii_case("//?/UNC/") {
        format!("//{}", &slashed[8..])
    } else if let Some(rest) = slashed.strip_prefix("//?/") {
        rest.to_string()
    } else {
        slashed
    };
    let bytes = slashed.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if drive || slashed.starts_with("//") {
        let (prefix, rest) = if drive {
            (slashed[..3].to_string(), &slashed[3..])
        } else {
            ("//".to_string(), &slashed[2..])
        };
        let mut parts: Vec<&str> = Vec::new();
        for part in rest.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        let joined = format!("{prefix}{}", parts.join("/"));
        return joined.trim_end_matches('/').to_lowercase();
    }
    node_path_resolve(directory).to_string_lossy().into_owned()
}

/// The `git:` identity the host remembered for exactly `directory`, if any. The host
/// writes one of these sidecars (`project-identities/<sha256 of the key>.json` in its
/// storage directory) after every successful git probe, so a directory whose git metadata
/// later disappears (a removed linked worktree) keeps its repository's memory pool.
fn read_remembered_git_identity(sidecar_dir: &Path, directory: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let key = project_directory_key(directory);
    let file = sidecar_dir.join(format!("{:x}.json", Sha256::digest(key.as_bytes())));
    let record: serde_json::Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if record.get("directory").and_then(serde_json::Value::as_str) != Some(key.as_str()) {
        return None;
    }
    let identity = record.get("identity").and_then(serde_json::Value::as_str)?;
    let hash = identity.strip_prefix("git:")?;
    ((7..=64).contains(&hash.len())
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then(|| identity.to_string())
}

/// Record `identity` as the one last resolved through git for exactly `directory`, in the
/// host's sidecar format, so a later process that cannot run git (or finds the checkout
/// gone) reuses it instead of starting a new pool. Written to a temporary file and renamed
/// so a reader never sees half a record. Best effort: a read-only storage directory must
/// not turn a successful probe into a failure.
fn remember_git_identity(sidecar_dir: &Path, directory: &Path, identity: &str) {
    use sha2::{Digest, Sha256};
    let key = project_directory_key(directory);
    let destination = sidecar_dir.join(format!("{:x}.json", Sha256::digest(key.as_bytes())));
    if read_remembered_git_identity(sidecar_dir, directory).as_deref() == Some(identity) {
        return;
    }
    let record = serde_json::json!({ "directory": key, "identity": identity }).to_string();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = destination.with_extension(format!("{}.{nanos}.tmp", std::process::id()));
    let written = std::fs::create_dir_all(sidecar_dir)
        .and_then(|()| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&temporary)?;
            std::io::Write::write_all(&mut file, record.as_bytes())
        })
        .and_then(|()| std::fs::rename(&temporary, &destination));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

/// Where the host keeps its remembered-identity sidecars: `project-identities/` beside the
/// `context.db` both processes resolve. Unit tests read and write none, so a test can
/// never touch the real storage directory.
fn default_sidecar_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    crate::host_store::resolve_context_db_path()
        .parent()
        .map(|storage| storage.join("project-identities"))
}

/// The key a route's history is filed under while its project identity is unavailable.
/// It names no project (no host computes it), so nothing project-scoped is shared under
/// it; it is stable per directory so the route's queued historian runs stay findable.
pub fn unavailable_project_key(directory: &Path) -> String {
    let directory_identity = directory_fallback(directory);
    format!(
        "unresolved:{}",
        directory_identity.trim_start_matches("dir:")
    )
}

#[derive(Clone)]
struct Cached {
    outcome: Result<String, ProjectIdentityError>,
    /// `None` for a `git:` identity, which never changes.
    revalidate_at: Option<Instant>,
}

/// Resolves and remembers identities for the life of the process.
#[derive(Default)]
pub struct ProjectIdentityResolver {
    cache: Mutex<HashMap<PathBuf, Cached>>,
    /// The last `git:` identity seen per resolved path, reused when a later git probe
    /// fails transiently so one checkout does not flap between two identities.
    last_git: Mutex<HashMap<PathBuf, String>>,
    /// The host's remembered-identity sidecar directory. `None` reads no sidecars.
    sidecar_dir: Option<PathBuf>,
}

impl ProjectIdentityResolver {
    pub fn new() -> Self {
        Self {
            sidecar_dir: default_sidecar_dir(),
            ..Self::default()
        }
    }

    /// A resolver reading the host's remembered identities from `sidecar_dir`.
    #[cfg(test)]
    fn with_sidecar_dir(sidecar_dir: PathBuf) -> Self {
        Self {
            sidecar_dir: Some(sidecar_dir),
            ..Self::default()
        }
    }

    fn remembered(&self, directory: &Path) -> Option<String> {
        read_remembered_git_identity(self.sidecar_dir.as_deref()?, directory)
    }

    /// The `git:` identity last known for `canonical` or an ancestor in the same
    /// repository, from this process or the host's sidecars. The walk stops at the first
    /// directory holding its own `.git`: a nested repository is a different project, and
    /// borrowing the outer repository's identity would put its memories in the wrong pool.
    fn nearest_known_git_identity(&self, canonical: &Path) -> Option<String> {
        let walk = |start: &Path| {
            let last = self
                .last_git
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let mut current = Some(start);
            while let Some(path) = current {
                if let Some(identity) = last.get(path).cloned().or_else(|| self.remembered(path)) {
                    return Some(identity);
                }
                if path.join(".git").exists() {
                    return None;
                }
                current = path.parent();
            }
            None
        };
        walk(canonical).or_else(|| {
            let real = realpath(canonical)?;
            (real != canonical).then(|| walk(&real)).flatten()
        })
    }

    /// The identity of `directory`, as the host's `resolveProjectIdentityForSession`
    /// computes it.
    pub fn resolve(&self, directory: &Path) -> Result<String, ProjectIdentityError> {
        let resolved = node_path_resolve(directory);
        if let Some(cached) = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&resolved)
            .cloned()
        {
            let fresh = cached
                .revalidate_at
                .is_none_or(|revalidate_at| Instant::now() < revalidate_at);
            // A `dir:` answer is only good while no repository has appeared around the
            // directory; the host re-resolves it as soon as one has, so the first commit
            // moves the project to its `git:` identity without waiting out the window.
            let stale_directory = cached
                .outcome
                .as_ref()
                .is_ok_and(|identity| identity.starts_with("dir:"))
                && git_root_directory(&resolved).is_some();
            if fresh && !stale_directory {
                return cached.outcome;
            }
        }
        let outcome = self.resolve_uncached(&resolved);
        // A refusal for a missing or home directory is not remembered: it costs no git
        // probe to repeat. A git failure is, so a broken or slow git is probed again only
        // after the same window the host waits before retrying.
        let remembered = match &outcome {
            Ok(_) | Err(ProjectIdentityError::GitUnavailable { .. }) => true,
            Err(_) => false,
        };
        if remembered {
            let revalidate_at = (!outcome
                .as_ref()
                .is_ok_and(|identity| identity.starts_with("git:")))
            .then(|| Instant::now() + DIRECTORY_REVALIDATE_AFTER);
            self.cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    resolved,
                    Cached {
                        outcome: outcome.clone(),
                        revalidate_at,
                    },
                );
        }
        outcome
    }

    fn resolve_uncached(&self, resolved: &Path) -> Result<String, ProjectIdentityError> {
        let display = resolved.display().to_string();
        let canonical_directory = realpath(resolved).unwrap_or_else(|| resolved.to_path_buf());
        // With no home directory at all there is nothing to refuse; `/` or the current
        // directory would wrongly refuse (or wrongly allow) an unrelated directory.
        if let Some(home) = crate::config::user_home_dir() {
            let canonical_home = realpath(&home).unwrap_or(home);
            let inherits_home =
                git_root_directory(&canonical_directory).is_some_and(|root| root == canonical_home);
            if canonical_directory == canonical_home || inherits_home {
                return Err(ProjectIdentityError::HomeDirectory { directory: display });
            }
        }
        match std::fs::metadata(resolved) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(ProjectIdentityError::Unreadable {
                    directory: display,
                    reason: "not a directory".to_string(),
                })
            }
            Err(error) => {
                return Err(ProjectIdentityError::Unreadable {
                    directory: display,
                    reason: error.to_string(),
                })
            }
        }
        if git_root_directory(resolved).is_none() {
            // No checkout here (any more). A directory the host once resolved through git
            // keeps that identity, as the host keeps it; only this exact path's record
            // counts, so a plain folder never borrows an ancestor repository's pool.
            return Ok(self
                .remembered(resolved)
                .unwrap_or_else(|| directory_fallback(resolved)));
        }
        if let Some(root) = git_root_commit(resolved) {
            let identity = format!("git:{root}");
            self.last_git
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(resolved.to_path_buf(), identity.clone());
            // Remember it across restarts, as the host does, for this path and for the
            // checkout root it belongs to.
            if let Some(sidecar_dir) = self.sidecar_dir.as_deref() {
                remember_git_identity(sidecar_dir, resolved, &identity);
                if let Some(root) = git_root_directory(resolved).filter(|root| root != resolved) {
                    remember_git_identity(sidecar_dir, &root, &identity);
                }
            }
            return Ok(identity);
        }
        if has_unborn_head(resolved) {
            // A repository with no commits yet has no root commit to name it by. The
            // directory hash stands in until the first commit, which the cache check above
            // picks up. This repository is its own project even when it sits inside
            // another checkout, so no outer identity is consulted.
            return Ok(directory_fallback(resolved));
        }
        // git failed for another reason: missing, timed out, refused the repository's
        // ownership, or found its metadata broken. Reuse the identity last known for this
        // repository, and otherwise refuse as the host does; a `dir:` identity here would
        // file memories under a key no host uses for this checkout.
        self.nearest_known_git_identity(resolved).ok_or_else(|| {
            ProjectIdentityError::GitUnavailable {
                directory: resolved.display().to_string(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(input, identity)` pairs printed by the host's `resolveProjectIdentity` for paths that
    /// do not exist, which is its `dir:` fallback of the resolved path.
    const DIRECTORY_GOLDEN: &[(&str, &str)] = &[
        ("/work/api", "dir:e02ef1f35c06"),
        ("/work/api/", "dir:e02ef1f35c06"),
        ("/work/./x/../api", "dir:e02ef1f35c06"),
        ("/tmp/n\u{e4}me dir", "dir:93e3ea277593"),
        ("/", "dir:6666cd76f969"),
    ];

    /// The root commit the host's `resolveProjectIdentityForSession` resolves for the fixed
    /// repository built in the checkout test, from the repository, a subdirectory, a trailing
    /// slash, a worktree and a symlink alike.
    const GOLDEN_ROOT_COMMIT: &str = "5dd1e9f0bd6f4800131f7c6887d174ffceac99d6";

    /// Values printed by the host's own function (see the module documentation) for the
    /// same inputs. A change on either side that alters them splits every project's
    /// memories between the host and the module.
    #[test]
    fn directory_identities_match_the_hosts_golden_vectors() {
        for (directory, expected) in DIRECTORY_GOLDEN {
            assert_eq!(
                directory_fallback(Path::new(directory)),
                *expected,
                "dir identity of {directory}"
            );
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "golden")
            .env("GIT_AUTHOR_EMAIL", "golden@example.invalid")
            .env("GIT_COMMITTER_NAME", "golden")
            .env("GIT_COMMITTER_EMAIL", "golden@example.invalid")
            .env("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            // Config injected through the environment (a shell or agent tool setting
            // core.hooksPath this way) would otherwise change the golden commit.
            .env("GIT_CONFIG_COUNT", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    }

    /// A fixed repository (fixed author, dates and content) has a fixed root commit, so the
    /// host's answer for it is a golden value too. Every spelling of a place inside the
    /// checkout (a worktree, a subdirectory, a trailing slash, a symlink) resolves to it.
    #[test]
    fn a_checkout_resolves_to_the_hosts_root_commit_identity_from_every_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README"), "golden\n").unwrap();
        git(&repo, &["add", "README"]);
        git(&repo, &["commit", "-q", "-m", "golden root"]);
        let worktree = dir.path().join("worktree");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "-b",
                "wt",
            ],
        );
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let resolver = ProjectIdentityResolver::new();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        for place in [
            repo.clone(),
            repo.join("sub"),
            PathBuf::from(format!("{}/", repo.display())),
            worktree,
            link,
        ] {
            assert_eq!(resolver.resolve(&place).unwrap(), expected, "{place:?}");
        }
    }

    #[test]
    fn a_directory_without_git_resolves_to_its_path_hash_and_a_missing_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let resolver = ProjectIdentityResolver::new();
        assert_eq!(
            resolver.resolve(&plain).unwrap(),
            directory_fallback(&plain)
        );
        let gone = dir.path().join("gone");
        assert!(matches!(
            resolver.resolve(&gone),
            Err(ProjectIdentityError::Unreadable { .. })
        ));
    }
    fn committed_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        git(path, &["init", "-q", "-b", "main"]);
        std::fs::write(path.join("README"), "golden\n").unwrap();
        git(path, &["add", "README"]);
        git(path, &["commit", "-q", "-m", "golden root"]);
    }

    /// A nested repository with no commits yet is its own project. Resolving the outer
    /// checkout first used to leave its identity behind for the nested one to borrow.
    #[test]
    fn a_new_nested_repository_does_not_take_the_outer_repositorys_identity() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        committed_repo(&outer);
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q", "-b", "main"]);

        let resolver = ProjectIdentityResolver::default();
        assert_eq!(
            resolver.resolve(&outer).unwrap(),
            format!("git:{GOLDEN_ROOT_COMMIT}")
        );
        let nested_identity = resolver.resolve(&nested).unwrap();
        assert_eq!(nested_identity, directory_fallback(&nested));
        // The answer must not depend on what this process resolved before.
        assert_eq!(
            ProjectIdentityResolver::default().resolve(&nested).unwrap(),
            nested_identity
        );
    }

    /// A checkout git cannot read is not a plain directory: the host pauses memory there
    /// rather than inventing a `dir:` identity, and so does the module.
    #[test]
    fn a_checkout_git_cannot_read_is_refused_not_given_a_directory_identity() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(".git"), "gitdir: /nonexistent/for/this/test\n").unwrap();
        let error = ProjectIdentityResolver::default()
            .resolve(&broken)
            .unwrap_err();
        assert!(
            matches!(error, ProjectIdentityError::GitUnavailable { .. }),
            "{error:?}"
        );
        assert_eq!(error.code(), "git_identity_unavailable");
    }

    /// A broken nested checkout inside a known repository is still a different project:
    /// the outer identity is not borrowed across the nested `.git`.
    #[test]
    fn a_broken_nested_checkout_does_not_borrow_the_outer_identity() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        committed_repo(&outer);
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(".git"), "gitdir: /nonexistent/for/this/test\n").unwrap();
        let resolver = ProjectIdentityResolver::default();
        resolver.resolve(&outer).unwrap();
        assert!(matches!(
            resolver.resolve(&nested),
            Err(ProjectIdentityError::GitUnavailable { .. })
        ));
    }

    /// When git fails for a directory inside a repository this process already resolved,
    /// the repository's identity is reused so its memory pool does not split.
    #[test]
    fn a_git_failure_inside_a_known_repository_reuses_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        committed_repo(&repo);
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let resolver = ProjectIdentityResolver::default();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        assert_eq!(resolver.resolve(&repo).unwrap(), expected);
        std::fs::write(repo.join(".git").join("HEAD"), "garbage\n").unwrap();
        assert_eq!(resolver.resolve(&repo.join("sub")).unwrap(), expected);
    }

    /// A folder whose git metadata is gone (a removed linked worktree) keeps the identity
    /// the host remembered for that exact path.
    #[test]
    fn a_directory_without_git_reads_the_hosts_remembered_identity_for_that_path() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let sidecars = dir.path().join("project-identities");
        std::fs::create_dir_all(&sidecars).unwrap();
        let folder = dir.path().join("former-worktree");
        std::fs::create_dir_all(folder.join("child")).unwrap();
        let key = project_directory_key(&folder);
        std::fs::write(
            sidecars.join(format!("{:x}.json", Sha256::digest(key.as_bytes()))),
            serde_json::json!({ "directory": key, "identity": "git:abcdef1234567" }).to_string(),
        )
        .unwrap();
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars);
        assert_eq!(resolver.resolve(&folder).unwrap(), "git:abcdef1234567");
        // Only the exact path's record counts.
        let child = folder.join("child");
        assert_eq!(
            resolver.resolve(&child).unwrap(),
            directory_fallback(&child)
        );
    }

    /// A successful probe is remembered in the host's sidecar format, so a later process
    /// whose git fails reuses the identity instead of pausing or splitting the pool.
    #[test]
    fn a_resolved_checkout_is_remembered_for_the_next_process() {
        let dir = tempfile::tempdir().unwrap();
        let sidecars = dir.path().join("project-identities");
        let repo = dir.path().join("repo");
        committed_repo(&repo);
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        let first = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        assert_eq!(first.resolve(&repo.join("sub")).unwrap(), expected);
        assert_eq!(
            read_remembered_git_identity(&sidecars, &repo.join("sub")).as_deref(),
            Some(expected.as_str())
        );
        // A fresh process whose git now fails still finds the identity.
        std::fs::write(repo.join(".git").join("HEAD"), "garbage\n").unwrap();
        let second = ProjectIdentityResolver::with_sidecar_dir(sidecars);
        assert_eq!(second.resolve(&repo.join("sub")).unwrap(), expected);
    }

    #[test]
    fn directory_keys_follow_the_hosts_spelling_rules() {
        assert_eq!(project_directory_key(Path::new("/work/api/")), "/work/api");
        assert_eq!(
            project_directory_key(Path::new("/work/./x/../api")),
            "/work/api"
        );
        assert_eq!(
            project_directory_key(Path::new("C:\\Users\\Me\\Repo\\")),
            "c:/users/me/repo"
        );
        assert_eq!(
            project_directory_key(Path::new("\\\\?\\C:\\Repo")),
            "c:/repo"
        );
        assert_eq!(
            project_directory_key(Path::new("\\\\?\\UNC\\Server\\Share\\x")),
            "//server/share/x"
        );
    }
}
