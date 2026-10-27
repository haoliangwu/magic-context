#!/usr/bin/env python3
"""Verify release workflows or wait fail-fast for CI on one exact commit."""

import argparse
import json
import os
import re
import subprocess
import sys
import time

REPOSITORY = "cortexkit/magic-context"


def inventory(route, key):
    result = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/{route}"],
        check=True, capture_output=True, text=True, timeout=60,
    )
    pages = json.loads(result.stdout)
    if not isinstance(pages, list) or not pages or any(not isinstance(page.get(key), list) for page in pages):
        raise RuntimeError(f"Invalid GitHub response for {key}")
    return [item for page in pages for item in page[key]]


def slow_required(run):
    return run.get("event") == "schedule" or str(run.get("head_branch", "")).startswith("train/check-")


def latest_run(sha, name, branch=None, slow_only=False):
    runs = inventory(f"actions/runs?head_sha={sha}&per_page=100", "workflow_runs")
    names = {name}
    if name == "Smoke":
        names.add("Smoke (opencode bring-up on Linux)")
    matches = [run for run in runs if run.get("head_sha") == sha and run.get("name") in names
               and (branch is None or (run.get("head_branch") == branch and run.get("event") == "push"))
               and (not slow_only or slow_required(run))]
    # Never reuse an older green run while a newer run is failing or unfinished.
    return max(matches, key=lambda run: int(run["id"])) if matches else None


# GitHub's head_sha run list can briefly omit runs that have just finished, so
# a missing run is looked up again a few times before the release is refused.
# A run that is present but unfinished, failed or cancelled is never retried.
MISSING_RUN_RETRIES = 4
MISSING_RUN_RETRY_SECONDS = 15


def missing_run_retry_seconds():
    # Only the offline release-script tests set this, so a missing-run case
    # does not spend a minute sleeping.
    return float(os.environ.get("CI_GATE_MISSING_RUN_RETRY_SECONDS", MISSING_RUN_RETRY_SECONDS))


def verify_slow_jobs(jobs):
    required = {f"Slow unit ({mode})" for mode in ("normal", "assertions")}
    successful = {job.get("name") for job in jobs
                  if job.get("status") == "completed" and job.get("conclusion") == "success"}
    missing = required - successful
    if missing:
        raise RuntimeError(f"required slow lane did not succeed: {', '.join(sorted(missing))}")


def verify_release(sha, sleep=time.sleep):
    delay = missing_run_retry_seconds()
    for name in ("CI", "Smoke"):
        run = latest_run(sha, name)
        for attempt in range(MISSING_RUN_RETRIES):
            if run:
                break
            print(f"{name} for {sha}: missing, looking again in {delay:g}s "
                  f"(retry {attempt + 1}/{MISSING_RUN_RETRIES})", flush=True)
            sleep(delay)
            run = latest_run(sha, name)
        if not run or run.get("status") != "completed" or run.get("conclusion") != "success":
            state = f"{run.get('status')}/{run.get('conclusion')}" if run else "missing"
            raise RuntimeError(f"{name} for {sha}: {state}, not completed/success")
        print(f"{name}: completed/success for {sha} (run {run['id']})", flush=True)
    # A later fast master run must not erase the exact candidate's slow evidence.
    slow = latest_run(sha, "CI", slow_only=True)
    if not slow or slow.get("status") != "completed" or slow.get("conclusion") != "success":
        raise RuntimeError(f"CI slow lane for {sha}: no completed/success nightly or train/check-* run")
    verify_slow_jobs(inventory(f"actions/runs/{int(slow['id'])}/jobs?filter=latest&per_page=100", "jobs"))
    print(f"Slow unit: completed/success for {sha} (run {slow['id']})", flush=True)


def wait_ci(sha, branch, timeout, interval):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = latest_run(sha, "CI", branch)
        if run:
            jobs = inventory(f"actions/runs/{int(run['id'])}/jobs?filter=latest&per_page=100", "jobs")
            for job in jobs:
                if job.get("conclusion") not in (None, "success", "skipped", "neutral"):
                    raise RuntimeError(f"CI job {job['name']}: {job['conclusion']} (run {run['id']}, {sha})")
            if run.get("status") == "completed":
                if run.get("conclusion") != "success":
                    raise RuntimeError(f"CI run {run['id']}: {run.get('conclusion')} ({sha})")
                if branch.startswith("train/check-"):
                    verify_slow_jobs(jobs)
                print(f"CI: completed/success for {sha} (run {run['id']})", flush=True)
                return
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"CI for {sha} timed out after {timeout:g}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("release", "wait"))
    parser.add_argument("sha")
    parser.add_argument("--branch")
    parser.add_argument("--timeout", type=float, default=7200)
    parser.add_argument("--interval", type=float, default=10)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("Expected a full commit SHA")
    if args.timeout <= 0 or args.interval <= 0:
        parser.error("Timeout and interval must be positive")
    if args.mode == "release":
        verify_release(args.sha)
    else:
        if not args.branch:
            parser.error("wait requires --branch")
        wait_ci(args.sha, args.branch, args.timeout, args.interval)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"ci-gate: {error}")
