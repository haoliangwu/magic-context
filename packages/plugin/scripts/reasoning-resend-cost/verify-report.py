"""Check report transcription against numeric scratch data, not private transcripts.

This proves arithmetic/selection/transcription consistency, not identical wire
prefixes, provider billing semantics, or tokenizer calibration accuracy.
"""
import json
from pathlib import Path
import re
import statistics
import sys


def key(harness, model):
    return {"OC1": "oc1", "Pi": "pi"}[harness] + "|" + model.removesuffix(" (text)").strip()


def main():
    root = Path(sys.argv[1])
    report = Path(sys.argv[2]).read_text()
    summary = json.loads((root / "summary.json").read_text())
    groups = {g["key"]: g for g in summary["groups"]}
    pairs = {}
    selected = {k: [] for k in groups}
    with (root / "pairs.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            pairs[(row["key"], row["id"], row["nextId"])] = row
            if row["gap"] <= 128 and row["body"] <= 512 and row["x"] > 0:
                selected[row["key"]].append(row)
    failures = []

    def check(name, fn):
        try:
            count = fn()
            print(f"PASS {name}: {count}")
        except (AssertionError, KeyError, ValueError) as error:
            failures.append(name)
            print(f"FAIL {name}: {error}")

    def regressions():
        for k, rows in selected.items():
            assert len(rows) == groups[k]["selected"], f"{k}: selection count"
            fitted = groups[k]["main"]
            if fitted is None:
                assert len(rows) < 3 or len({r['x'] for r in rows}) == 1, k
                continue
            x, y = [r["x"] for r in rows], [r["y"] for r in rows]
            mx, my = statistics.mean(x), statistics.mean(y)
            slope = sum((a - mx) * (b - my) for a, b in zip(x, y)) / sum((a - mx) ** 2 for a in x)
            assert abs(slope - fitted["k"]) < 1e-9, f"{k}: slope"
            assert abs(my - slope * mx - fitted["c"]) < 1e-7, f"{k}: intercept"
        return f"{len(groups)} independently recomputed model fits; {sum(map(len, selected.values()))} selected pairs"

    def model_table():
        seen = set()
        section = report.split("## Per-provider/model measurements", 1)[1].split("### Stability", 1)[0]
        for line in section.splitlines():
            match = re.match(r"^\| (OC1|Pi) ([^|]+) \| (\d+) \|", line)
            if not match:
                continue
            k = key(match[1], match[2])
            g = groups[k]
            cells = [s.strip() for s in line.split("|")[1:-1]]
            assert int(cells[1]) == g["steps"], f"{k}: steps"
            assert int(cells[2].split("/")[0]) == g["selected"], f"{k}: n"
            m = g["main"]
            if m is not None:
                assert int(cells[2].split("/")[1]) == m["sessions"], f"{k}: sessions"
                for cell, value in [(cells[3].split()[0], m["k"]), (cells[4], m["c"]), (cells[6], m["adversarial20PercentBodyAndWrappersShift"])]:
                    assert abs(float(cell) - value) <= 0.000501, f"{k}: {cell} != {value}"
                if m["cluster95"] is not None:
                    interval_match = re.search(r"\[([^]]+)\]", cells[3])
                    assert interval_match is not None, f"{k}: interval absent"
                    interval = interval_match[1].split(",")
                    assert len(interval) == 2, f"{k}: interval endpoints"
                    assert all(abs(float(a) - b) <= 0.000501 for a, b in zip(interval, m["cluster95"])), f"{k}: interval"
                ratios = cells[5].split("/")
                assert len(ratios) == 3, f"{k}: three ratio quantiles"
                assert all(abs(float(a) - b) <= 0.000501 for a, b in zip(ratios, m["ratioQ10Q50Q90"])), f"{k}: ratios"
            else:
                assert cells[3] == "—", f"{k}: unidentifiable slope should be absent"
            seen.add(k)
        assert seen == set(groups), f"missing model rows: {set(groups) - seen}"
        return f"{len(seen)} model rows"

    def examples():
        current, visible, n = None, [], 0
        counts = {}
        for line in report.splitlines():
            heading = re.match(r"^### (OC1|Pi) — (.+)$", line)
            if heading:
                current = key(heading[1], heading[2])
                visible = []
                continue
            if line.startswith("Independent V="):
                visible = [float(s) for s in re.findall(r"\d+(?:\.\d+)?", line)]
            match = re.match(r"^\| `([^`]+)` → `([^`]+)` \|", line)
            if not match or current is None:
                continue
            row = pairs[(current, match[1], match[2])]
            cells = [s.strip() for s in line.split("|")[1:-1]]
            a, b = [[float(s) for s in cells[i].split("/")] for i in [1, 2]]
            for raw, u in [(a, row["usage"]), (b, row["nextUsage"])]:
                assert raw == [u[s] for s in ["input", "output", "reasoning", "read", "write"]], f"{match[1]}: raw usage"
            x, body, wrappers, y = [float(cells[i]) for i in range(3, 7)]
            assert x == row["x"] and wrappers == row["wrappers"], f"{match[1]}: x/wrappers"
            assert abs(body - row["body"]) <= 0.00501, f"{match[1]}: body"
            assert abs(y - row["y"]) <= 0.00501, f"{match[1]}: estimated resent"
            assert row["gap"] <= 128 and row["body"] <= 512 and row["x"] > 0, f"{match[1]}: not selected"
            if row["basis"] == "text":
                v = visible.pop(0)
                assert abs(v - row["visibleLocal"]) < 1e-6, f"{match[1]}: independent V"
            else:
                v = a[1] - (a[2] if current.startswith("pi|") else 0)
            computed = b[0] + b[3] + b[4] - a[0] - a[3] - a[4] - v - body - wrappers
            assert abs(computed - y) <= 0.01001, f"{match[1]}: displayed arithmetic"
            n += 1
            counts[current] = counts.get(current, 0) + 1
        for k, rows in selected.items():
            assert counts.get(k, 0) >= min(3, len(rows)), f"{k}: missing examples"
        return f"{n} raw token examples including text-route independent visible counts"

    print(f"Python {sys.version.split()[0]}: numeric report verification (3 named checks)")
    check("independent regressions", regressions)
    check("model table matches numeric observations", model_table)
    check("raw examples match numeric observations", examples)
    print(f"{3 - len(failures)} passed; {len(failures)} failed")
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
