#!/usr/bin/env bun
/**
 * Print per-stage mean / median / p90 / max over the measured passes of one or
 * more `run.ts` reports, plus each pass's served hash, so two runs of the same
 * schedule can be compared by eye or by `diff`.
 *
 *   bun summarize-stages.ts report.json [--skip N] [--stages a,b,c]
 *
 * `--skip N` drops the first N passes (cold warm-up passes that tag the whole
 * projection). Stage values are the sum of a stage's samples within one pass.
 */
import { readFileSync } from "node:fs";
import type { PerfRunReport } from "./run";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const path = args.find(
	(arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
);
if (!path) throw new Error("usage: summarize-stages.ts report.json [--skip N]");
const skip = Number(flag("--skip") ?? "0");
const only = flag("--stages")?.split(",");
const report = JSON.parse(readFileSync(path, "utf8")) as PerfRunReport;
const measured = report.passes.slice(skip);
const stages = only ?? [
	...new Set(measured.flatMap((pass) => pass.stages.map((s) => s.stage))),
];
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const at = (values: number[], fraction: number) =>
	values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
const rows = stages.map((stage) => {
	const values = sorted(
		measured.map((pass) =>
			pass.stages
				.filter((sample) => sample.stage === stage)
				.reduce((sum, sample) => sum + sample.elapsedMs, 0),
		),
	);
	const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
	return {
		stage,
		mean,
		median: at(values, 0.5),
		p90: at(values, 0.9),
		max: values.at(-1) ?? 0,
	};
});
rows.sort((a, b) => b.mean - a.mean);
console.log(
	`passes=${measured.length} (skipped ${skip}) inputMessages=${measured.at(-1)?.inputMessages} tags=${measured.at(-1)?.tagRows} bytes=${measured.at(-1)?.outputBytes}`,
);
console.log("stage | mean | median | p90 | max");
for (const row of rows) {
	if (row.max < 0.5 && !only) continue;
	console.log(
		`${row.stage} | ${row.mean.toFixed(2)} | ${row.median.toFixed(2)} | ${row.p90.toFixed(2)} | ${row.max.toFixed(2)}`,
	);
}
const queries = new Map<string, { ms: number; ops: number }>();
for (const pass of measured) {
	for (const query of pass.dbQueries) {
		const flat = query.sql.replace(/\s+/g, " ").trim();
		const from = flat.indexOf(" FROM ");
		// Statements sharing a long column list differ only after FROM.
		const key = (
			from > 60 ? `${flat.slice(0, 40)} …${flat.slice(from)}` : flat
		).slice(0, 220);
		const total = queries.get(key) ?? { ms: 0, ops: 0 };
		total.ms += query.elapsedMs;
		total.ops += query.operations;
		queries.set(key, total);
	}
}
console.log("top SQL (mean ms per measured pass | ops per pass | sql)");
for (const [sql, total] of [...queries]
	.sort((a, b) => b[1].ms - a[1].ms)
	.slice(0, Number(flag("--queries") ?? "12"))) {
	console.log(
		`${(total.ms / measured.length).toFixed(2)} | ${(total.ops / measured.length).toFixed(1)} | ${sql}`,
	);
}
for (const pass of report.passes) {
	const extra =
		pass.stages.find((s) => s.stage === "getTagsBySessionSnapshot")?.extra ??
		"";
	console.log(
		`pass ${pass.pass} in=${pass.inputMessages} out=${pass.outputMessages} bytes=${pass.outputBytes} wire=${pass.wireHash.slice(0, 12)} tags=${pass.tagRowsHash.slice(0, 12)} ${extra} ${pass.chaos?.length ? `chaos=${pass.chaos.join(",")}` : ""}`,
	);
}
