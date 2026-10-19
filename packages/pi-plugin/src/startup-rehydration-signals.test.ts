import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Pi startup rehydration signal contract", () => {
	it("rehydrates pending Pi marker sessions into history and materialization signals", () => {
		const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		const block = source.slice(
			source.indexOf("let pendingPiMarkerSessions"),
			source.indexOf(
				"Magic Context (pi) failed to rehydrate deferred Pi compaction markers",
			),
		);
		const helper = source.slice(
			source.indexOf("function signalPiDeferredCompactionMarkerDrain"),
			source.indexOf("export function persistPiMessageEndModelMeta"),
		);
		expect(block).toContain("signalPiDeferredCompactionMarkerDrain(sid)");
		expect(helper).toContain("signalPiDeferredHistoryRefresh(sessionId)");
		expect(helper).toContain("signalPiDeferredMaterialization(sessionId)");
		expect(source).toContain(
			"formatPiMarkerRehydrationLine(pendingPiMarkerSessions, sessionId)",
		);
		expect(block).not.toContain("signalPiPendingMaterialization(sid)");
		expect(helper).not.toContain("signalPiPendingMaterialization(sessionId)");
	});
});
