"""Synthetic regression checks; never connect to a live store."""
import contextlib
import importlib.util
import io
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = pathlib.Path(__file__).with_name("dreamer-batch-cost-profile.py")
SPEC = importlib.util.spec_from_file_location("batch_cost", MODULE_PATH)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class BatchCostFitTest(unittest.TestCase):
    def test_fixed_and_per_memory_cost_are_recovered(self):
        result = PROFILE.fit([(n, 600_000 + 50_000 * n) for n in [1, 5, 10, 20, 50]], 1)
        self.assertAlmostEqual(result["coefficients"][0], 600_000)
        self.assertAlmostEqual(result["coefficients"][1], 50_000)
        self.assertAlmostEqual(result["r_squared"], 1)

    def test_quadratic_cost_is_recovered(self):
        result = PROFILE.fit([(n, 10_000 + 1_000 * n + 20 * n * n) for n in [1, 5, 10, 20, 50]], 2)
        for actual, expected in zip(result["coefficients"], [10_000, 1_000, 20]):
            self.assertAlmostEqual(actual, expected)

    def test_insufficient_size_variation_has_no_fit(self):
        self.assertIsNone(PROFILE.fit([(20, 100), (20, 200)], 1))
        self.assertIsNone(PROFILE.fit([(10, 100), (20, 200)], 2))

    def test_single_child_join_is_read_only_and_counts_distinct_memories(self):
        with tempfile.TemporaryDirectory() as root:
            db_path = pathlib.Path(root) / "context.db"
            output_path = pathlib.Path(root) / "runs.csv"
            db = sqlite3.connect(db_path)
            db.executescript("""
                CREATE TABLE subagent_invocations(id, session_id, harness, subagent, task, provider_id, model_id,
                    started_at, ended_at, status, input_tokens, cache_read_tokens, cache_write_tokens);
                CREATE TABLE dream_runs(id, project_path, started_at, finished_at, parent_session_id, tasks_json);
                CREATE TABLE memory_verifications(memory_id, verified_at, mapped_at);
                CREATE TABLE memories(id, project_path);
                INSERT INTO subagent_invocations VALUES(1,'parent','opencode','dreamer','verify','google',
                    'antigravity-gemini-3.8-flash',1790790000000,1790790005000,'completed',100,200,300);
                INSERT INTO dream_runs VALUES(1,'project',1790790000000,1790790006000,'parent',
                    '[{"name":"verify","progress":"verify: processed 1 (verified 1, updated 0, archived 0, skipped 0, refused 0); 0 remain"}]');
                INSERT INTO memories VALUES(1,'project');
                INSERT INTO memory_verifications VALUES(1,1790790004000,1790790004000),(1,1790790004000,1790790004000);
            """)
            db.close()
            before = db_path.read_bytes()
            connect = sqlite3.connect

            def audited_connect(*args, **kwargs):
                connection = connect(*args, **kwargs)
                with self.assertRaisesRegex(sqlite3.OperationalError, "readonly"):
                    connection.execute("INSERT INTO memories VALUES(2,'project')")
                connection.rollback()
                return connection

            with patch("sys.argv", [str(MODULE_PATH), "--db", str(db_path), "--as-of", "2026-09-30T19:00:00Z", "--csv", str(output_path)]):
                with patch.object(PROFILE.sqlite3, "connect", audited_connect):
                    with contextlib.redirect_stdout(io.StringIO()):
                        PROFILE.main()
            import csv
            with output_path.open() as output:
                rows = list(csv.DictReader(output))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["prompt_tokens"], "600")
            self.assertEqual(rows[0]["processed"], "1")
            self.assertEqual(rows[0]["current_state_count"], "1")
            self.assertEqual(rows[0]["fit_eligible"], "True")
            self.assertEqual(db_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
