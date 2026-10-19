import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const evidence = JSON.parse(
	readFileSync(join(root, "differential.json"), "utf8"),
);
let checks = 0;
const check = (condition) => {
	assert(condition);
	checks++;
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const arm of evidence.arms) {
	const runner = readFileSync(join(root, `${arm.name}-runner.json`));
	const btw = readFileSync(join(root, `${arm.name}-btw.json`));
	const main = JSON.parse(runner.toString());
	const side = JSON.parse(btw.toString());
	const field = (raw, body, key) => {
		const value = JSON.stringify(body[key]);
		const marker = `"${key}":${value}`;
		const offset = raw.toString().indexOf(marker);
		check(offset >= 0);
		return { bytes: Buffer.from(value), end: offset + marker.length };
	};
	const input = field(runner, main, "input");
	const prefix = Buffer.from(runner.toString().slice(0, input.end - 1));
	const sidePrefix = btw.subarray(0, prefix.length);
	check(prefix.equals(sidePrefix) === (arm.name === "after"));
	check(prefix.length === arm.wirePrefixBytes);
	check(sha(prefix) === arm.runnerPrefixSha256);
	check(sha(sidePrefix) === arm.btwPrefixSha256);
	check(runner.length === arm.runnerBytes && btw.length === arm.btwBytes);
	for (const key of ["instructions", "tools"]) {
		const served = field(runner, main, key).bytes;
		check(served.equals(field(btw, side, key).bytes));
		check(sha(served) === arm[`${key}Sha256`]);
	}
	const inventory = readFileSync(join(root, `${arm.name}-lsof.txt`), "utf8");
	const databases = [
		...new Set(
			inventory
				.split("\n")
				.filter((line) => line.startsWith("n"))
				.map((line) => line.slice(1))
				.filter((path) => /\.db(-wal|-shm)?$/.test(path)),
		),
	];
	check(
		databases.length > 0 &&
			databases.every((path) => path.startsWith(`${arm.root}/`)),
	);
	check(databases.includes(`${arm.root}/XDG_DATA_HOME/opencode/opencode2.db`));
	check(
		databases.includes(
			`${arm.root}/XDG_DATA_HOME/cortexkit/magic-context/context.db`,
		),
	);
}
console.log(
	`Captured-wire audit: ${checks} assertions passed; before prefix unequal, after prefix equal; instructions/tools unchanged within each arm; all lsof DB handles confined to throwaway roots.`,
);
