#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import type { PerfRunReport } from "./run";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath)
	throw new Error("usage: summarize-append.ts before.json after.json");
const before = JSON.parse(readFileSync(beforePath, "utf8")) as PerfRunReport;
const after = JSON.parse(readFileSync(afterPath, "utf8")) as PerfRunReport;
if (before.passes.length !== after.passes.length)
	throw new Error("pass counts differ");
for (let index = 0; index < before.passes.length; index++) {
	const old = before.passes[index];
	const current = after.passes[index];
	if (!old || !current) throw new Error("missing pass");
	for (const key of [
		"wireHash",
		"outputHash",
		"tagRowsHash",
		"outputBytes",
	] as const) {
		if (old[key] === undefined || old[key] !== current[key])
			throw new Error(`pass ${index + 1}: ${key} differs`);
	}
}
// This large-session protocol seeds hidden tags after the 13,800 checkpoint.
// Exclude warm-up and its first two-message catch-up append (<= 13,802), not
// later slow samples. Reports must use that checkpoint/append schedule.
const measured = (run: PerfRunReport) =>
	run.passes.filter((pass) => pass.inputMessages > 13_802);
const percentile = (values: number[], fraction: number) => {
	values.sort((a, b) => a - b);
	return Number(
		(values[Math.ceil(values.length * fraction) - 1] ?? 0).toFixed(3),
	);
};
const stages = [
	...new Set(
		after.passes.flatMap((pass) => pass.stages.map((sample) => sample.stage)),
	),
];
const timings = Object.fromEntries(
	stages.map((stage) => [
		stage,
		Object.fromEntries(
			[
				["before", before],
				["after", after],
			].map(([name, run]) => {
				const values = measured(run as PerfRunReport).map((pass) =>
					pass.stages
						.filter((sample) => sample.stage === stage)
						.reduce((sum, sample) => sum + sample.elapsedMs, 0),
				);
				return [
					name,
					{
						medianMs: percentile([...values], 0.5),
						p90Ms: percentile([...values], 0.9),
					},
				];
			}),
		),
	]),
);
console.log(
	JSON.stringify(
		{
			bun: Bun.version,
			byteIdenticalPasses: before.passes.length,
			assertions: before.passes.length * 4,
			appendSamples: measured(after).length,
			messages: after.passes.at(-1)?.inputMessages,
			tags: after.passes.at(-1)?.tagRows,
			servedBytes: after.passes.at(-1)?.outputBytes,
			timings,
		},
		null,
		2,
	),
);
