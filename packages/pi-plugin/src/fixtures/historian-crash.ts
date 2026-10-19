import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { insertTag } from "@magic-context/core/features/magic-context/storage";
import { runPiHistorian } from "../pi-historian-runner";
import { createTestDb } from "../test-utils.test";

const [path, phase] = process.argv.slice(2);
if (!path || !process.env.HOME)
	throw new Error("missing isolated fixture paths");
const db = createTestDb(path);
const sessionId = "crash-historian";
const directory = join(process.env.HOME, "project");
mkdirSync(directory, { recursive: true });
const holder = "killed-holder";
if (!acquireCompartmentLease(db, sessionId, holder))
	throw new Error("missing lease");
const messages = Array.from({ length: 12 }, (_, index) => ({
	ordinal: index + 1,
	id: `m${index + 1}`,
	role: index % 2 === 0 ? "user" : "assistant",
	parts: [{ type: "text", text: `Synthetic work ${index}` }],
}));
for (let index = 0; index < messages.length; index++) {
	insertTag(db, sessionId, `m${index + 1}:p0`, "message", 100, index + 1);
}
function park(label: string): never {
	process.stdout.write(`${label}\n`);
	// Pause at the selected provider/COMMIT checkpoint until the test sends SIGKILL.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	throw new Error("unreachable");
}
const exec = db.exec.bind(db);
db.exec = (sql: string) => {
	if (
		sql === "COMMIT" &&
		(
			db.prepare("SELECT COUNT(*) AS n FROM compartments").get() as {
				n: number;
			}
		).n > 0
	) {
		if (phase === "before-commit") park("BEFORE_COMMIT");
		const value = exec(sql);
		if (phase === "after-commit") park("AFTER_COMMIT");
		return value;
	}
	return exec(sql);
};
await runPiHistorian({
	db,
	sessionId,
	directory,
	provider: { readMessages: () => messages },
	runner: {
		harness: "pi",
		run: async () => {
			if (phase === "provider") park("PROVIDER_STARTED");
			return {
				ok: true,
				durationMs: 1,
				assistantText:
					'<compartment start="1" end="2" title="Completed work"><p1>Summary of the first completed turn.</p1></compartment>',
			};
		},
	},
	historianModel: "test/model",
	historianChunkTokens: 20000,
	historianContextLimit: 200000,
	producerContextLimits: new Map([["test/model", 200000]]),
	compartmentLeaseHolderId: holder,
	memoryEnabled: false,
});
throw new Error("historian never reached requested crash boundary");
