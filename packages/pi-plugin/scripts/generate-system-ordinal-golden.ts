import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// This historical converter counts system entries in the ordinal space used by
// persisted compartments. Execute it to generate independent expected values,
// rather than deriving the golden from the implementation under test.
const sourceRef = "59d2ef9c3b293b491adb39971cfd598439b98022";
const sourcePath = "packages/pi-plugin/src/read-session-pi.ts";
const root = join(import.meta.dir, "../../..");
const source = execFileSync("git", ["show", `${sourceRef}:${sourcePath}`], {
	cwd: root,
	encoding: "utf8",
});
const sourceBlob = execFileSync(
	"git",
	["rev-parse", `${sourceRef}:${sourcePath}`],
	{ cwd: root, encoding: "utf8" },
).trim();
const fixtureDir = join(import.meta.dir, "../src/fixtures");
const entries: unknown[] = JSON.parse(
	readFileSync(join(fixtureDir, "system-ordinals-pi.input.json"), "utf8"),
);
const temporarySource = join(
	import.meta.dir,
	`../src/.system-ordinal-baseline-${process.pid}.ts`,
);
writeFileSync(temporarySource, source, { flag: "wx" });
try {
	const baseline = await import(pathToFileURL(temporarySource).href);
	const rawMessages = baseline.convertEntriesToRawMessages(entries);
	writeFileSync(
		join(fixtureDir, "system-ordinals-pi.master.json"),
		`${JSON.stringify({ sourceRef, sourcePath, sourceBlob, rawMessages }, null, "\t")}\n`,
	);
	console.log(
		`Generated canonical ordinal golden from ${sourceRef} blob ${sourceBlob}`,
	);
} finally {
	unlinkSync(temporarySource);
}
