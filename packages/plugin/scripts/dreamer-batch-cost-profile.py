#!/usr/bin/env python3
"""Read-only, single-child outcome joins for dreamer batch-cost sizing.

Only reads the live database. CSV output belongs in a report/throwaway directory,
never beside the live store. Current verification rows are corroboration, not
historical counts: later verification replaces both mapped_at and verified_at.
"""
import argparse
import collections
import csv
import datetime
import json
import math
import pathlib
import re
import sqlite3


def solve(matrix, rhs):
    rows = [list(row) + [value] for row, value in zip(matrix, rhs)]
    for col in range(len(rhs)):
        pivot = max(range(col, len(rhs)), key=lambda row: abs(rows[row][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        if abs(rows[col][col]) < 1e-10:
            return None
        scale = rows[col][col]
        rows[col] = [value / scale for value in rows[col]]
        for row in range(len(rhs)):
            if row != col:
                factor = rows[row][col]
                rows[row] = [a - factor * b for a, b in zip(rows[row], rows[col])]
    return [row[-1] for row in rows]


def fit(points, degree):
    if len(set(n for n, _ in points)) < degree + 1:
        return None
    # Scale the explanatory variable to keep the normal equations well-conditioned.
    x = [[(n / 50) ** power for power in range(degree + 1)] for n, _ in points]
    matrix = [[sum(row[i] * row[j] for row in x) for j in range(degree + 1)] for i in range(degree + 1)]
    rhs = [sum(row[i] * y for row, (_, y) in zip(x, points)) for i in range(degree + 1)]
    beta = solve(matrix, rhs)
    if beta is None:
        return None
    beta = [value / 50 ** power for power, value in enumerate(beta)]
    predictions = [sum(value * n ** power for power, value in enumerate(beta)) for n, _ in points]
    errors = [y - predicted for (_, y), predicted in zip(points, predictions)]
    sse = sum(error ** 2 for error in errors)
    mean = sum(y for _, y in points) / len(points)
    total = sum((y - mean) ** 2 for _, y in points)
    rmse = math.sqrt(sse / len(points))
    aic = len(points) * math.log(max(sse / len(points), 1)) + 2 * (degree + 1)
    return {"coefficients": beta, "r_squared": 1 - sse / total if total else None,
            "rmse": rmse, "aic": aic}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--as-of", required=True, help="UTC ISO timestamp; fixed endpoint for a 14-day window")
    parser.add_argument("--csv", type=pathlib.Path, required=True)
    args = parser.parse_args()
    endpoint = datetime.datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
    end = int(endpoint.timestamp() * 1000)
    start = end - 14 * 86_400_000
    db = sqlite3.connect(args.db.expanduser().resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    attempts = [dict(row) for row in db.execute(
        "SELECT * FROM subagent_invocations WHERE subagent='dreamer' "
        "AND task IN ('verify','verify-broad','map-memories') "
        "AND started_at>=? AND ended_at<?", (start, end))]
    runs = [dict(row) for row in db.execute(
        "SELECT * FROM dream_runs WHERE finished_at>=? AND started_at<?", (start, end))]
    associated = collections.defaultdict(list)
    for run in runs:
        for task in json.loads(run["tasks_json"]):
            candidates = [row for row in attempts if row["session_id"] == run["parent_session_id"]
                          and row["task"] == task["name"]
                          and run["started_at"] - 1000 <= row["started_at"] <= run["finished_at"]
                          and row["ended_at"] <= run["finished_at"] + 1000]
            for row in candidates:
                associated[row["id"]].append((run, task, len(candidates)))
    records = []
    for row in attempts:
        if row["status"] != "completed":
            continue
        links = associated[row["id"]]
        record = {key: row[key] for key in ["id", "harness", "task", "provider_id", "model_id",
                                          "started_at", "ended_at", "input_tokens", "cache_read_tokens", "cache_write_tokens"]}
        record["prompt_tokens"] = sum(row[key] for key in ["input_tokens", "cache_read_tokens", "cache_write_tokens"])
        record.update(dream_run_id="", processed="", inferred_batch_size="", current_state_count="",
                      join_quality="unmatched", fit_eligible=False)
        if len(links) == 1:
            run, task, children = links[0]
            record["dream_run_id"] = run["id"]
            record["join_quality"] = "multi-child" if children != 1 else "single-child"
            stamp = "mapped_at" if row["task"] == "map-memories" else "verified_at"
            record["current_state_count"] = db.execute(
                f"SELECT COUNT(DISTINCT v.memory_id) FROM memory_verifications v "
                f"JOIN memories m ON m.id=v.memory_id WHERE m.project_path=? AND v.{stamp} BETWEEN ? AND ?",
                (run["project_path"], row["started_at"], row["ended_at"])).fetchone()[0]
            if children == 1:
                if row["task"] == "map-memories":
                    backlog = task.get("backlog", {})
                    record["processed"] = backlog.get("processed", "")
                    # Exactly one child invocation completed this mapping task and
                    # emptied its initial unmapped-memory pool. Remapping existing
                    # rows does not reduce that pool, so its work is not counted.
                    if backlog.get("pendingAtEnd") == 0:
                        record["inferred_batch_size"] = backlog.get("pendingAtStart", "")
                else:
                    match = re.search(r"processed (\d+) \(verified (\d+), updated (\d+), archived (\d+), skipped (\d+), refused (\d+)\); (\d+) remain", task.get("progress", ""))
                    if match:
                        values = list(map(int, match.groups()))
                        record["processed"] = sum(values[1:4])
                        if values[-1] == 0:
                            record["inferred_batch_size"] = values[0]
                size = record["inferred_batch_size"]
                record["fit_eligible"] = (not task.get("error") and isinstance(size, int) and size > 0
                                          and record["prompt_tokens"] > 0)
        records.append(record)
    db.close()
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with args.csv.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(records[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(sorted(records, key=lambda row: row["id"]))
    summary = {"window": [datetime.datetime.fromtimestamp(start / 1000, datetime.timezone.utc).isoformat(), endpoint.isoformat()],
               "completed": len(records), "join_quality": dict(collections.Counter(row["join_quality"] for row in records)), "fits": {}}
    for task in ["verify", "verify-broad", "map-memories"]:
        rows = [row for row in records if row["task"] == task and row["harness"] == "opencode"
                and row["model_id"] == "antigravity-gemini-3.8-flash" and row["fit_eligible"]]
        points = [(row["inferred_batch_size"], row["prompt_tokens"]) for row in rows]
        summary["fits"][task] = {"n": len(points), "distinct_sizes": sorted(set(n for n, _ in points)),
                                 "linear": fit(points, 1), "quadratic": fit(points, 2)}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
