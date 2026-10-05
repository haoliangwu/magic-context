import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getLastCompartmentEndMessage,
	getLastCompartmentEndMessageId,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { readPiHistorianTail } from "../../../src/historian-tail-pi";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	countPiRawMessages,
} from "../../../src/read-session-pi";
import { buildAccumulationPasses, loadFixture } from "./fixtures";
import { canonicalHash } from "./instrumentation";

const root = process.argv[2];
if (!root)
	throw new Error(
		"Pass the throwaway directory containing the session and database copies",
	);
const fixture = loadFixture(join(root, "session.jsonl"));
const lastPass = buildAccumulationPasses(fixture, []).at(-1);
if (!lastPass) throw new Error("The fixture has no message pass");
const branch = lastPass.branchEntries;
const db = new Database(join(root, "context.db"), { readonly: true });
const end = getLastCompartmentEndMessage(db, fixture.sessionId);
const anchor = getLastCompartmentEndMessageId(db, fixture.sessionId);
const whole = convertEntriesToRawMessages(branch);
const expected = whole.slice(end - 1);
if (whole[end - 1]?.id !== anchor)
	throw new Error("Active branch does not prove anchor");
const reports = [];
for (let run = 1; run <= 5; run++)
	for (const arm of run % 2 === 1 ? ["full", "paged"] : ["paged", "full"]) {
		Bun.gc(true);
		let fullReads = 0;
		const start = performance.now();
		const result =
			arm === "full"
				? {
						messages: convertEntriesToRawMessages(branch),
						absoluteMessageCount: whole.length,
					}
				: readPiHistorianTail(db, fixture.sessionId, {
						readMessages: () => {
							fullReads++;
							return convertEntriesToRawMessages(branch);
						},
						readMessagePage: (after, limit, watermark) =>
							convertEntriesToRawMessagePage(branch, after, limit, watermark),
						getMessageCount: () => countPiRawMessages(branch),
					});
		const elapsedMs = performance.now() - start;
		const tail =
			arm === "full" ? result.messages.slice(end - 1) : result.messages;
		if (JSON.stringify(tail) !== JSON.stringify(expected))
			throw new Error("Tail bytes differ");
		if (result.absoluteMessageCount !== whole.length || fullReads !== 0)
			throw new Error("Paging fell back or count changed");
		reports.push({
			run,
			arm,
			elapsedMs,
			fullReads,
			hydratedMessages: result.messages.length,
			absoluteMessageCount: result.absoluteMessageCount,
			anchorOrdinal: end,
			anchorMatches: true,
			tailHash: canonicalHash(tail),
		});
	}
writeFileSync(
	join(root, "historian-tail-profile.json"),
	JSON.stringify(reports, null, 2),
);
console.log(JSON.stringify(reports));
db.close();
