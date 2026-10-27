#!/usr/bin/env python3
"""Offline release fixtures: all network, tag and publish operations are refused or logged."""

import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(os.environ["TEST_ROOT"]).resolve()
cwd = Path.cwd().resolve()
if root not in (cwd, *cwd.parents):
    sys.exit("Release fixture escaped its temporary directory")
scenario = json.loads((root / "scenario.json").read_text())
args = sys.argv[1:]
name = Path(sys.argv[0]).name
with (root / "commands.jsonl").open("a") as log:
    log.write(json.dumps({"name": name, "args": args}) + "\n")


def git(*command):
    return subprocess.check_output([os.environ["REAL_GIT"], *command], cwd=cwd, text=True).strip()


if name == "gh":
    if args[:1] == ["api"] and any("/actions/runs?head_sha=" in arg for arg in args):
        if scenario.get("api_failure"):
            sys.exit(9)
        expected = scenario["base"]
        if "--paginate" not in args or "--slurp" not in args or not any(f"head_sha={expected}" in arg for arg in args):
            sys.exit("Release query must paginate the full certified SHA")
        runs = [{"id": index + 10, "name": workflow, "head_sha": expected,
                 "status": "completed", "conclusion": "success", "head_branch": "train/check-pr-123", "event": "push"}
                for index, workflow in enumerate(("CI", "Smoke"))]
        for run in runs:
            run.update(scenario.get("workflows", {}).get(run["name"], {}))
        runs = [run for run in runs if run["name"] != scenario.get("missing")]
        for run in runs:
            if run["name"] == "Smoke":
                run["name"] = "Smoke (opencode bring-up on Linux)"
        runs.extend(scenario.get("extra_runs", []))
        print(json.dumps([{"workflow_runs": runs}]))
    elif args[:1] == ["api"] and any("/jobs?" in arg for arg in args):
        jobs = [{"name": f"Slow unit ({mode})", "status": "completed", "conclusion": "success"}
                for mode in ("normal", "assertions")]
        print(json.dumps([{"jobs": scenario.get("slow_jobs", jobs)}]))
    elif args[:2] == ["run", "list"] and "--workflow=release.yml" in args:
        print(777)
    elif args[:3] == ["run", "watch", "777"]:
        pass
    elif args[:3] == ["run", "view", "777"]:
        if "status" in args:
            print("completed")
        elif "conclusion" in args:
            print("success")
        else:
            sys.exit("Unexpected release run query")
    else:
        sys.exit("Unexpected gh command; writes forbidden: " + repr(args))
elif name == "git":
    if args[:1] == ["push"] or args[:2] == ["tag", "-a"]:
        print("Fixture remote/tag operation (no side effect)")
    elif any(arg in ("fetch", "pull", "clone", "ls-remote", "send-pack") for arg in args):
        sys.exit("Unshimmed remote git command refused")
    else:
        status = subprocess.call([os.environ["REAL_GIT"], *args], cwd=cwd)
        if status == 0 and args[:1] == ["commit"] and scenario.get("amend_source"):
            (cwd / "source.ts").write_text("changed by commit hook\n")
            git("add", "source.ts")
            git("commit", "--amend", "--no-edit")
        sys.exit(status)
elif name == "bun":
    if args[:1] == ["scripts/version-sync.mjs"]:
        status = subprocess.call([os.environ["REAL_BUN"], *args], cwd=cwd)
        if status:
            sys.exit(status)
        if scenario.get("stage_source"):
            (cwd / "source.ts").write_text("unexpected source change\n")
            git("add", "source.ts")
        if scenario.get("manifest_dependency"):
            path = cwd / "packages/plugin/package.json"
            manifest = json.loads(path.read_text())
            manifest["dependencies"] = {"unverified": "1.0.0"}
            path.write_text(json.dumps(manifest) + "\n")
        if scenario.get("cargo_manifest_content"):
            path = cwd / "crates/mc-module/Cargo.toml"
            path.write_text(path.read_text() + 'description = "unverified fixture edit"\n')
        if scenario.get("cargo_lock_content"):
            path = cwd / "Cargo.lock"
            path.write_text(path.read_text() + "# unverified fixture edit\n")
    elif args[:1] == ["packages/plugin/scripts/build-schema.ts"]:
        (cwd / "assets/magic-context.schema.json").write_text('{"fixture": "fresh schema"}\n')
        if scenario.get("fail_generator") == "schema":
            sys.exit(7)
    elif args[:1] == ["packages/plugin/scripts/build-reference-seeds.ts"]:
        (cwd / "packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts").write_text('export const seed = "fresh seed";\n')
        if scenario.get("fail_generator") == "seeds":
            sys.exit(7)
    else:
        if any(arg in ("lint", "typecheck", "test") for arg in args):
            print("Unexpected local gate: " + " ".join(args), file=sys.stderr)
            sys.exit(41)
        print("Fixture artifact build/check: " + " ".join(args))
elif name == "curl":
    print('"9.8.7":"2026-10-01T00:00:00.000Z"')
else:
    sys.exit("Unexpected release fixture command: " + name)
