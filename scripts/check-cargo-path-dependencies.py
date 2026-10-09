#!/usr/bin/env python3
"""Reject Cargo path dependencies that resolve outside the repository."""

import argparse
import contextlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

VIOLATION_EXIT = 3
CHECK_ERROR_EXIT = 1
WORKSPACE_MANIFESTS = ("Cargo.toml", "packages/dashboard/src-tauri/Cargo.toml")


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def cargo_metadata(manifest: Path) -> dict:
    result = subprocess.run(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path", str(manifest)],
        cwd=manifest.parent,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"cargo metadata failed for {manifest}: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"cargo metadata returned invalid JSON for {manifest}: {error}") from error


def check_workspaces(repo_root: Path, manifests: list[Path]) -> int:
    violations = []
    errors = []
    for manifest in manifests:
        try:
            metadata = cargo_metadata(manifest)
        except (OSError, RuntimeError) as error:
            errors.append(str(error))
            continue
        for package in metadata["packages"]:
            if package.get("source") is not None:
                continue
            resolved_manifest = Path(package["manifest_path"]).resolve()
            if not is_within(resolved_manifest, repo_root):
                violations.append((manifest, package["name"], resolved_manifest))

    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    if errors:
        return CHECK_ERROR_EXIT
    if violations:
        print("Cargo path dependencies resolved outside the repository root:", file=sys.stderr)
        for workspace_manifest, name, resolved_manifest in violations:
            print(
                f"  {workspace_manifest}: {name} -> {resolved_manifest}",
                file=sys.stderr,
            )
        return VIOLATION_EXIT
    print(f"Cargo path dependency check passed for {len(manifests)} workspaces.")
    return 0


def write_crate(directory: Path, name: str, version: str = "1.0.0") -> None:
    (directory / "src").mkdir(parents=True, exist_ok=True)
    (directory / "Cargo.toml").write_text(
        f'[package]\nname = "{name}"\nversion = "{version}"\nedition = "2021"\n'
    )
    (directory / "src/lib.rs").write_text("pub fn fixture() {}\n")


def write_fixture_root(root: Path, scenario: str) -> list[Path]:
    root.mkdir(parents=True)
    dependencies = ['in-repo-control = { path = "crates/in-repo-control" }']
    patch = ""
    if scenario == "direct":
        dependencies.append('outside-direct = { path = "../outside-direct" }')
        write_crate(root.parent / "outside-direct", "outside-direct")
    elif scenario == "patch":
        dependencies.append('outside-patch = "=1.0.0"')
        patch = '\n[patch.crates-io]\noutside-patch = { path = "../outside-patch" }\n'
        write_crate(root.parent / "outside-patch", "outside-patch")
    (root / "src").mkdir(parents=True)
    (root / "src/lib.rs").write_text("pub fn fixture() {}\n")
    manifest = (
        '[package]\nname = "path-policy-fixture"\nversion = "0.1.0"\nedition = "2021"\n'
        "\n[dependencies]\n" + "\n".join(dependencies) + "\n" + patch
    )
    (root / "Cargo.toml").write_text(manifest)
    write_crate(root / "crates/in-repo-control", "in-repo-control")

    dashboard = root / "packages/dashboard/src-tauri"
    dashboard.mkdir(parents=True)
    (dashboard / "src").mkdir()
    (dashboard / "src/lib.rs").write_text("pub fn fixture() {}\n")
    (dashboard / "Cargo.toml").write_text(
        '[package]\nname = "dashboard-path-policy-fixture"\nversion = "0.1.0"\n'
        'edition = "2021"\n\n[dependencies]\ndashboard-control = { path = "control" }\n'
    )
    write_crate(dashboard / "control", "dashboard-control")

    for workspace_manifest in (root / "Cargo.toml", dashboard / "Cargo.toml"):
        result = subprocess.run(
            ["cargo", "generate-lockfile", "--offline", "--manifest-path", str(workspace_manifest)],
            cwd=workspace_manifest.parent,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode:
            detail = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(f"could not prepare self-test lockfile: {detail}")
    return [root / name for name in WORKSPACE_MANIFESTS]


def run_self_test() -> int:
    cases = (
        ("test_direct_outside_path_refused", "direct", VIOLATION_EXIT, "outside-direct"),
        ("test_outside_patch_path_refused", "patch", VIOLATION_EXIT, "outside-patch"),
        ("test_in_repo_path_control_passes", "control", 0, "in-repo-control"),
    )
    failures = 0
    with tempfile.TemporaryDirectory(prefix="cargo-path-policy-") as temporary:
        for test_name, scenario, expected_code, expected_package in cases:
            root = Path(temporary) / scenario / "repository"
            try:
                manifests = write_fixture_root(root, scenario)
                output = io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    actual_code = check_workspaces(root.resolve(), manifests)
                report = output.getvalue()
                if actual_code != expected_code:
                    raise AssertionError(f"expected exit {expected_code}, got {actual_code}; {report.strip()}")
                if expected_code == VIOLATION_EXIT and expected_package not in report:
                    raise AssertionError(f"expected {expected_package} in violation report; {report.strip()}")
                if expected_code == 0 and "passed for 2 workspaces" not in report:
                    raise AssertionError(f"in-repo control did not pass both workspaces; {report.strip()}")
                print(f"PASS {test_name}")
            except (OSError, RuntimeError, AssertionError) as error:
                failures += 1
                print(f"FAIL {test_name}: {error}", file=sys.stderr)
    if failures:
        print(f"{failures} path dependency policy self-test(s) failed.", file=sys.stderr)
        return CHECK_ERROR_EXIT
    print(f"All {len(cases)} path dependency policy self-tests passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="exercise direct, patch, and in-repository path cases")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()

    repo_root = Path(__file__).resolve().parents[1]
    manifests = [repo_root / name for name in WORKSPACE_MANIFESTS]
    missing = [path for path in manifests if not path.is_file()]
    if missing:
        for path in missing:
            print(f"ERROR: expected workspace manifest is missing: {path}", file=sys.stderr)
        return CHECK_ERROR_EXIT
    return check_workspaces(repo_root, manifests)


if __name__ == "__main__":
    sys.exit(main())
