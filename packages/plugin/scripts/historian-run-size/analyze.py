#!/usr/bin/env python3
"""Summarize historian telemetry from a COPIED context.db and optional log files.

Create snapshots separately with SQLite's read-only VACUUM INTO. This script has
no live-store discovery, migration, or write path. Output contains aggregates,
not conversation text. Dates and half-open period boundaries are UTC.
"""

import argparse
import collections
import datetime as dt
import json
from pathlib import Path
import re
import sqlite3
import statistics
import tempfile
import unittest


PERIODS = [
    ("Sep 01-08", "2026-09-01", "2026-09-09"),
    ("Sep 09-15", "2026-09-09", "2026-09-16"),
    ("Sep 16-17", "2026-09-16", "2026-09-18"),
    ("Sep 18-20", "2026-09-18", "2026-09-21"),
    ("Sep 21", "2026-09-21", "2026-09-22"),
    ("Sep 22-23", "2026-09-22", "2026-09-24"),
    ("Sep 24-30", "2026-09-24", "2026-10-01"),
    ("Oct 01-04", "2026-10-01", "2026-10-05"),
]
SESSIONS = {
    "ses_227ce5788ffeRPA9THoPLOQreO": "ALF",
    "ses_313660571ffeZTsf4koSJwk50Q": "AFT",
    "ses_114f158ccffet7znXAgI7lc3Kp": "BROCA",
    "ses_331acff95fferWZOYF1pG0cjOn": "MC",
}
FIRE_PATTERNS = {
    "force_band": "compartment trigger: force-firing",
    "commit_clusters": "compartment trigger: commit-cluster fire",
    "tail_size": "compartment trigger: tail-size fire",
    "projected_headroom": "compartment trigger: proactive fire",
}
RUST_COMPLETE = re.compile(
    r'historian firing finished for (\S+): Completed\(.*model: "([^"]+)"'
)


def timestamp(text):
    value = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return int(value.timestamp() * 1000)


def period(ms):
    for label, start, end in PERIODS:
        if timestamp(start) <= ms < timestamp(end):
            return label
    return None


def summarize(rows):
    n = len(rows)
    spans = [r["chunk_end_ordinal"] - r["chunk_start_ordinal"] + 1 for r in rows
             if r["chunk_start_ordinal"] is not None and r["chunk_end_ordinal"] is not None]
    return {
        "n": n,
        "span_n": len(spans),
        "chunk_mean": round(statistics.mean(spans), 1) if spans else None,
        "chunk_median": statistics.median(spans) if spans else None,
        "compartments_mean": round(sum(r["compartments_produced"] for r in rows) / n, 2),
        "one_pct": round(100 * sum(r["compartments_produced"] == 1 for r in rows) / n, 1),
        "discard_pct": round(100 * sum(bool(r["discarded_last"]) for r in rows) / n, 1),
        "one_without_discard": sum(r["compartments_produced"] == 1 and not r["discarded_last"]
                                   for r in rows),
    }


def group(rows, key):
    buckets = collections.defaultdict(list)
    for row in rows:
        buckets[key(row)].append(row)
    return [{"group": list(k), **summarize(v)} for k, v in sorted(buckets.items())]


def scan_logs(paths):
    counts = collections.Counter()
    examples = {}
    coverage = []
    rust = []
    for path in paths:
        first = last = None
        with path.open(errors="replace") as stream:
            for line_number, line in enumerate(stream, 1):
                match = re.search(r"2026-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z", line)
                if not match:
                    continue
                text_time = match.group()
                first = first or text_time
                last = text_time
                sid_match = re.search(r"ses_[A-Za-z0-9]+", line)
                sid = sid_match.group() if sid_match else "unknown"
                for reason, phrase in FIRE_PATTERNS.items():
                    if phrase in line:
                        key = (path.name, sid, reason)
                        counts[key] += 1
                        examples.setdefault(key, {"line": line_number, "text": line.strip()})
                if "historian" in line.lower() and ("prompt fit" in line.lower()
                                                     or "producer_prompt_unfit" in line):
                    key = (path.name, sid, "prompt_fit_diagnostic")
                    counts[key] += 1
                    examples.setdefault(key, {"line": line_number, "text": line.strip()})
                complete = RUST_COMPLETE.search(line)
                if complete:
                    rust.append({"session_id": complete[1], "model": complete[2],
                                 "created_at": timestamp(text_time), "file": path.name,
                                 "line": line_number})
        coverage.append({"file": str(path), "first": first, "last": last})
    return {
        "coverage": coverage,
        "trigger_log_lines": [{"file": k[0], "session": k[1], "reason": k[2],
                               "n": n, "example": examples[k]}
                              for k, n in sorted(counts.items())],
        "rust_completions": rust,
    }


def analyze(path, logs):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro")
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in db.execute("""
            SELECT r.*, CASE WHEN s.model_id IS NULL THEN 'unknown'
                ELSE s.provider_id || '/' || s.model_id END model
            FROM historian_runs r LEFT JOIN subagent_invocations s
              ON s.id = r.subagent_invocation_id
            WHERE r.run_kind = 'incremental'
              AND r.created_at >= ? AND r.created_at < ?
            ORDER BY r.created_at, r.id
        """, (timestamp("2026-09-01"), timestamp("2026-10-05")))]
        batches = [dict(r) for r in db.execute("""
            SELECT session_id, harness, created_at,
                   min(start_message) chunk_start_ordinal,
                   max(end_message) chunk_end_ordinal,
                   count(*) compartments_produced, 0 discarded_last
            FROM compartments
            WHERE created_at >= ? AND created_at < ?
              AND session_id IN (?, ?, ?, ?)
              AND coalesce(episode_type, '') != 'filtered-noise'
            GROUP BY session_id, harness, created_at
        """, (timestamp("2026-09-01"), timestamp("2026-10-05"), *SESSIONS))]
    finally:
        db.close()
    successes = [r for r in rows if r["status"] == "success"]
    result = {
        "snapshot": str(path.resolve()),
        "status_counts": dict(collections.Counter(r["status"] for r in rows)),
        "period_harness": group(successes, lambda r: (period(r["created_at"]), r["harness"])),
        "daily": group(successes, lambda r: (
            dt.datetime.fromtimestamp(r["created_at"] / 1000, dt.timezone.utc).date().isoformat(),)),
        "session_period": group([r for r in successes if r["session_id"] in SESSIONS],
                                lambda r: (SESSIONS[r["session_id"]], period(r["created_at"]))),
        "model_period": group(successes, lambda r: (period(r["created_at"]), r["model"])),
        "model_session": group([r for r in successes if r["session_id"] in SESSIONS],
                               lambda r: (SESSIONS[r["session_id"]], r["model"])),
        "opencode_span_150_300": group(
            [r for r in successes if r["harness"] == "opencode"
             and r["chunk_start_ordinal"] is not None and r["chunk_end_ordinal"] is not None
             and 150 <= r["chunk_end_ordinal"] - r["chunk_start_ordinal"] + 1 <= 300],
            lambda r: (r["model"],)),
        "publication_batches": group(batches, lambda r: (
            SESSIONS[r["session_id"]], period(r["created_at"]))),
    }
    # Publication batches expose retained spans, NOT input chunk size or discard.
    # Those fields cannot be reconstructed from the surviving compartment rows.
    for row in result["publication_batches"]:
        row["published_span_mean"] = row.pop("chunk_mean")
        row["published_span_median"] = row.pop("chunk_median")
        row.pop("discard_pct")
        row.pop("one_without_discard")
    if logs:
        log_data = scan_logs(logs)
        # This is an explicitly approximate correlation, not durable mode metadata.
        # Require an unambiguous success within five seconds, allowing mirror delay.
        matched = {}
        unmatched = ambiguous = 0
        for item in log_data["rust_completions"]:
            candidates = [r for r in successes if r["session_id"] == item["session_id"]
                          and abs(r["created_at"] - item["created_at"]) <= 5000]
            if len(candidates) == 1 and candidates[0]["id"] not in matched:
                matched[candidates[0]["id"]] = candidates[0]
            elif candidates:
                ambiguous += 1
            else:
                unmatched += 1
        result["rust_correlated_successes"] = group(
            list(matched.values()), lambda r: (period(r["created_at"]), r["harness"]))
        result["rust_correlation"] = {"matched": len(matched), "unmatched": unmatched,
                                      "ambiguous_or_duplicate": ambiguous, "tolerance_ms": 5000}
        result["rust_completion_counts"] = dict(collections.Counter(
            item["model"] for item in log_data.pop("rust_completions")))
        result["logs"] = log_data
    return result


class AnalysisTests(unittest.TestCase):
    def test_span_and_discard_are_independent(self):
        rows = [dict(chunk_start_ordinal=10, chunk_end_ordinal=109,
                     compartments_produced=1, discarded_last=0),
                dict(chunk_start_ordinal=100, chunk_end_ordinal=299,
                     compartments_produced=3, discarded_last=1)]
        self.assertEqual(summarize(rows), dict(n=2, span_n=2, chunk_mean=150.0,
                         chunk_median=150.0, compartments_mean=2.0, one_pct=50.0,
                         discard_pct=50.0, one_without_discard=1))

    def test_half_open_utc_period(self):
        self.assertEqual(period(timestamp("2026-09-08T23:59:59Z")), "Sep 01-08")
        self.assertEqual(period(timestamp("2026-09-09T00:00:00Z")), "Sep 09-15")
        self.assertIsNone(period(timestamp("2026-10-05")))
        self.assertEqual(timestamp("2026-09-09T02:00:00+02:00"),
                         timestamp("2026-09-09T00:00:00Z"))

    def test_completion_is_not_a_trigger_or_a_failure(self):
        self.assertIsNone(RUST_COMPLETE.search("historian firing for ses_abc: await_timeout_ms=600000"))
        self.assertIsNone(RUST_COMPLETE.search("historian firing finished for ses_abc: Failed(foo)"))
        match = RUST_COMPLETE.search('historian firing finished for ses_abc: Completed(X { model: "google/flash" })')
        assert match is not None
        self.assertEqual(match.groups(), ("ses_abc", "google/flash"))

    def test_copied_database_joins_and_filters(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "context-copy.db"
            db = sqlite3.connect(path)
            db.executescript("""
                CREATE TABLE historian_runs (id, subagent_invocation_id, session_id,
                  harness, run_kind, status, created_at, chunk_start_ordinal,
                  chunk_end_ordinal, compartments_produced, discarded_last);
                CREATE TABLE subagent_invocations (id, provider_id, model_id);
                CREATE TABLE compartments (session_id, harness, created_at,
                  start_message, end_message, episode_type);
                INSERT INTO subagent_invocations VALUES (1, 'google', 'flash');
            """)
            now = timestamp("2026-09-24")
            for id_, status, kind in [(1, "success", "incremental"),
                                      (2, "noop", "incremental"),
                                      (3, "success", "recomp")]:
                db.execute("INSERT INTO historian_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (id_, 1, next(iter(SESSIONS)), "opencode", kind, status,
                            now, 1, 100, 1, 0))
            db.execute("INSERT INTO compartments VALUES (?,?,?,?,?,?)",
                       (next(iter(SESSIONS)), "opencode", now, 1, 75, "feature"))
            db.commit()
            db.close()
            before = path.read_bytes()
            result = analyze(path, [])
            self.assertEqual(result["status_counts"], {"success": 1, "noop": 1})
            self.assertEqual(result["model_period"][0]["group"],
                             ["Sep 24-30", "google/flash"])
            self.assertEqual(result["period_harness"][0]["chunk_mean"], 100)
            self.assertEqual(result["publication_batches"][0]["published_span_mean"], 75)
            self.assertNotIn("discard_pct", result["publication_batches"][0])
            self.assertEqual(path.read_bytes(), before)

    def test_log_counts_exclude_non_firing_lines(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "sample.log"
            path.write_text(
                "[2026-10-04T00:00:00.001Z] [ses_abc] compartment trigger: not firing\n"
                "[2026-10-04T00:00:01.001Z] [ses_abc] compartment trigger: proactive fire\n"
                "2026-10-04T00:00:02.001Z historian firing finished for ses_abc: "
                'Completed(X { model: "google/flash" })\n')
            result = scan_logs([path])
            self.assertEqual(len(result["trigger_log_lines"]), 1)
            self.assertEqual(result["trigger_log_lines"][0]["reason"], "projected_headroom")
            self.assertEqual(result["trigger_log_lines"][0]["n"], 1)
            self.assertEqual(len(result["rust_completions"]), 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context-copy", type=Path)
    parser.add_argument("--log", type=Path, action="append", default=[])
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(AnalysisTests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(not result.wasSuccessful())
    if not args.context_copy:
        parser.error("--context-copy must name an already-created database copy")
    print(json.dumps(analyze(args.context_copy, args.log), indent=2))


if __name__ == "__main__":
    main()
