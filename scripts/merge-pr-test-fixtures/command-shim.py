#!/usr/bin/env python3
"""Read-only API fixtures and remote-only git shims for isolated merge tests."""
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

root = Path(os.environ["TEST_ROOT"]).resolve()
cwd = Path.cwd().resolve()
if root not in (cwd, *cwd.parents):
    sys.exit("Shim refused a command outside the isolated test directory")
scenario = json.loads((root / "scenario.json").read_text())
log_path = root / "commands.jsonl"
previous = [json.loads(line) for line in log_path.read_text().splitlines()] if log_path.exists() else []
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with log_path.open("a") as log:
    log.write(json.dumps({"name": name, "args": args, "cwd": str(cwd)}) + "\n")


def real_git(*command):
    return subprocess.call([os.environ["REAL_GIT"], *command], cwd=cwd)


if name == "gh":
    if scenario.get("shim_refusal"):
        print('gh-shim: gh_shim_unclassified: verb "api" is not declared in manifest', file=sys.stderr)
        sys.exit(86)
    if scenario.get("api_failure"):
        sys.exit(9)
    if args[:2] == ["api", "graphql"]:
        fields = dict(arg.split("=", 1) for arg in args if "=" in arg)
        if fields.get("owner") != "cortexkit" or fields.get("repo") != "magic-context" or fields.get("number") != "123":
            sys.exit("Unexpected GraphQL variables")
        query = fields["query"]
        for fragment in ("headRefOid", "isCrossRepository", "state", "baseRefName", "reviewThreads(first:100, after:$cursor)", "comments(first:1)"):
            if fragment not in query:
                sys.exit("Query missing required field: " + fragment)
        index = int(fields.get("cursor", "page-0").split("-")[-1])
        pages = scenario.get("threads", [[]])
        pr = {
            "number": 123,
            "headRefOid": scenario["head"],
            "isCrossRepository": True,
            "state": scenario.get("state", "OPEN"),
            "baseRefName": scenario.get("base", "master"),
            "title": scenario.get("title", 'A safe "quoted" title; $(touch SHOULD_NOT_EXIST)'),
            "reviewThreads": {
                "nodes": pages[index],
                "pageInfo": {"hasNextPage": index + 1 < len(pages), "endCursor": "page-" + str(index + 1)},
            },
        }
        prior_queries = sum(item["name"] == "gh" and item["args"][:2] == ["api", "graphql"] for item in previous)
        if prior_queries and "recheck" in scenario:
            pr.update(scenario["recheck"])
        if scenario.get("missing_pr"):
            pr = None
        response: dict[str, Any] = {"data": {"repository": {"pullRequest": pr}}}
        if scenario.get("graphql_errors"):
            response["errors"] = [{"message": "fixture GraphQL failure"}]
        print(json.dumps(response))
    elif args[:1] == ["api"] and any("/check-runs?per_page=100" in arg for arg in args):
        if "--paginate" not in args or "--slurp" not in args or not any(scenario["head"] in arg for arg in args):
            sys.exit("Check-runs query must paginate the exact head")
        print(json.dumps(scenario.get("check_pages", [{"check_runs": []}])))
    else:
        sys.exit("Unexpected gh command (all writes forbidden): " + repr(args))
elif name == "git":
    if args[:2] == ["fetch", "origin"]:
        if args[2:] == ["master"]:
            sys.exit(real_git("update-ref", "refs/remotes/origin/master", scenario.get("origin_master", scenario["master"])))
        if args[2:] == ["pull/123/head"]:
            (cwd / ".git/FETCH_HEAD").write_text(scenario.get("fetched_head", scenario["head"]) + "\n")
            sys.exit(0)
        sys.exit("Unexpected fetch")
    if args[:1] == ["push"]:
        if args != ["push", "origin", "master"]:
            sys.exit("Unexpected push")
        print("Fixture push (no network)")
    else:
        if any(arg in ("clone", "pull", "ls-remote", "send-pack") for arg in args):
            sys.exit("Unshimmed remote git command refused")
        if args[:1] == ["-C"]:
            target = Path(args[1]).resolve()
            if root not in (target, *target.parents):
                sys.exit("git -C escaped the fixture")
        sys.exit(real_git(*args))
elif name in ("bun", "bunx", "cargo"):
    command = " ".join([name, *args])
    print("Fixture runner: " + command)
    if command == scenario.get("fail_runner"):
        print("Fixture runner failed", file=sys.stderr)
        sys.exit(scenario.get("runner_status", 7))
else:
    sys.exit("Unexpected shim name")
