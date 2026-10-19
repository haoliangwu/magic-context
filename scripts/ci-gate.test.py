#!/usr/bin/env python3
"""Focused tests for exact-run selection and bounded, fail-fast CI waits."""

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("ci_gate", Path(__file__).with_name("ci-gate.py"))
assert spec and spec.loader
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = "a" * 40


class GateTests(unittest.TestCase):
    def test_latest_run_excludes_wrong_sha_branch_event_and_name(self):
        good = {"id": 1, "name": "CI", "head_sha": SHA, "head_branch": "train/check-pr-123", "event": "push"}
        runs = [good, dict(good, id=2), dict(good, id=3, head_sha="b" * 40),
                dict(good, id=4, head_branch="master"), dict(good, id=5, event="pull_request"),
                dict(good, id=6, name="Smoke")]
        with patch.object(gate, "inventory", return_value=runs):
            self.assertEqual(gate.latest_run(SHA, "CI", "train/check-pr-123"), dict(good, id=2))

    def test_failed_job_on_later_page_is_not_hidden(self):
        pages = '[{"jobs": []}, {"jobs": [{"name": "late job", "conclusion": "failure"}]}]'
        with patch.object(gate.subprocess, "run") as command:
            command.return_value.stdout = pages
            self.assertEqual(gate.inventory("actions/runs/1/jobs?per_page=100", "jobs"),
                             [{"name": "late job", "conclusion": "failure"}])
            self.assertIn("--paginate", command.call_args.args[0])

    def test_missing_run_times_out_instead_of_passing(self):
        now = [0]
        with patch.object(gate, "latest_run", return_value=None), \
                patch.object(gate.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(gate.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
            with self.assertRaisesRegex(RuntimeError, "timed out after 23s"):
                gate.wait_ci(SHA, "train/check-pr-123", 23, 10)
        self.assertEqual(now[0], 23)

    def test_unsuccessful_run_refuses_even_without_failed_job(self):
        for conclusion in ("failure", "cancelled", "timed_out", "skipped", "neutral", None):
            with self.subTest(conclusion=conclusion), \
                    patch.object(gate, "latest_run", return_value={"id": 1, "status": "completed", "conclusion": conclusion}), \
                    patch.object(gate, "inventory", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "CI run 1:"):
                    gate.wait_ci(SHA, "train/check-pr-123", 23, 10)

    def test_unsuccessful_job_fails_before_run_completes(self):
        for conclusion in ("failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"):
            with self.subTest(conclusion=conclusion), \
                    patch.object(gate, "latest_run", return_value={"id": 1, "status": "in_progress"}), \
                    patch.object(gate, "inventory", return_value=[{"name": "broken job", "conclusion": conclusion}]):
                with self.assertRaisesRegex(RuntimeError, f"CI job broken job: {conclusion}"):
                    gate.wait_ci(SHA, "train/check-pr-123", 23, 10)


if __name__ == "__main__":
    unittest.main()
