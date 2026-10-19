import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import {
	acquireCompartmentLease,
	releaseCompartmentLeaseBestEffort,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearPiHistoryBoundaryRepairSession,
	repairPiHistoryBoundary,
} from "./history-boundary-repair-pi";
import { assistantMessage, createTestDb, userMessage } from "./test-utils.test";

function fixture(
	messageCount = 13_800,
	compartmentCount = 1_500,
	path?: string,
) {
	const db = createTestDb(path);
	const sessionId = `history-check-cost-${crypto.randomUUID()}`;
	const entry = (index: number) => ({
		id: `e-${index}`,
		parentId: index === 0 ? null : `e-${index - 1}`,
		type: "message",
		timestamp: new Date(index + 1).toISOString(),
		message:
			index % 2 === 0
				? userMessage(`request ${index}`, index + 1)
				: assistantMessage(`answer ${index}`, index + 1),
	});
	const original = Array.from({ length: messageCount }, (_, index) =>
		entry(index),
	);
	let entries = [...original];
	const byId = new Map(entries.map((row) => [row.id, row]));
	const content = "Durable summary content. ".repeat(170);
	const compartments = Array.from(
		{ length: compartmentCount },
		(_, sequence) => {
			const startMessage =
				Math.floor((sequence * messageCount) / compartmentCount) + 1;
			const endMessage = Math.floor(
				((sequence + 1) * messageCount) / compartmentCount,
			);
			return {
				sequence,
				startMessage,
				endMessage,
				startMessageId: `e-${startMessage - 1}`,
				endMessageId: `e-${endMessage - 1}`,
				title: `Summary ${sequence}`,
				content,
				p1: content,
				p2: content.slice(0, 1024),
				p3: content.slice(0, 256),
				p4: "",
			};
		},
	);
	appendCompartments(db, sessionId, compartments);
	const ctx = {
		sessionManager: {
			getLeafId: () => entries.at(-1)?.id ?? null,
			getBranch: () => entries,
			getEntry: (id: string) => byId.get(id),
		},
	};
	return {
		db,
		sessionId,
		original,
		compartments,
		ctx,
		get entries() {
			return entries;
		},
		setBranch(next: typeof entries) {
			entries = next;
		},
		append() {
			const next = entry(entries.length);
			entries.push(next);
			byId.set(next.id, next);
		},
		check(branch: readonly unknown[] = entries) {
			repairPiHistoryBoundary(db, sessionId, ctx, branch);
		},
		close() {
			clearPiHistoryBoundaryRepairSession(sessionId);
			db.close();
		},
	};
}

it("history repair append gate reads one revision, no compartment rows or historical entries", () => {
	const f = fixture();
	try {
		f.check();
		f.append();
		let entryReads = 0;
		let iterations = 0;
		const branch = new Proxy(f.entries, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) entryReads++;
				if (key === Symbol.iterator) iterations++;
				return Reflect.get(target, key, receiver);
			},
		});
		const prepared = spyOn(f.db, "prepare");
		try {
			f.check(branch);
			expect(entryReads).toBeLessThanOrEqual(2);
			expect(iterations).toBe(0);
			const sql = prepared.mock.calls.map(([query]) => String(query));
			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain("FROM compartment_history_versions");
			expect(sql.some((query) => /\bFROM compartments\b/.test(query))).toBe(
				false,
			);
		} finally {
			prepared.mockRestore();
		}
	} finally {
		f.close();
	}
});

it("history repair cold and reset checks select only boundary IDs, never summary bodies", () => {
	const f = fixture(12, 3);
	const prepared = spyOn(f.db, "prepare");
	try {
		f.check();
		f.check();
		clearPiHistoryBoundaryRepairSession(f.sessionId);
		f.check();
		const reads = prepared.mock.calls
			.map(([query]) => String(query))
			.filter((query) => /^SELECT .*\bFROM compartments\b/.test(query));
		expect(reads).toEqual(
			Array(2).fill(
				"SELECT sequence, COALESCE(end_message_id, '') AS endMessageId FROM compartments WHERE session_id = ? ORDER BY sequence",
			),
		);
	} finally {
		prepared.mockRestore();
		f.close();
	}
});

it("history repair gate invalidates on publication and same-size boundary rewrites", () => {
	const f = fixture(12, 3);
	try {
		f.check();
		f.append();
		appendCompartments(f.db, f.sessionId, [
			{
				...f.compartments[2]!,
				sequence: 3,
				startMessage: 13,
				endMessage: 13,
				startMessageId: "e-12",
				endMessageId: "e-12",
			},
		]);
		const prepared = spyOn(f.db, "prepare");
		try {
			f.check();
			expect(
				prepared.mock.calls.some(([sql]) =>
					String(sql).startsWith("SELECT sequence, COALESCE(end_message_id"),
				),
			).toBe(true);
		} finally {
			prepared.mockRestore();
		}
		// A summary rewrite or sibling writer can change an end without changing either
		// the number of rows or their sequences. The persistent revision catches it.
		f.db
			.prepare(
				"UPDATE compartments SET end_message_id = 'old-sibling' WHERE session_id = ? AND sequence = 1",
			)
			.run(f.sessionId);
		f.check();
		expect(
			getCompartments(f.db, f.sessionId).map((row) => row.sequence),
		).toEqual([0]);
	} finally {
		f.close();
	}
});

it("history repair gate does not cache an unresolved retirement while another writer owns it", () => {
	const f = fixture(12, 3);
	try {
		f.check();
		f.setBranch(f.original.slice(0, 6));
		expect(acquireCompartmentLease(f.db, f.sessionId, "other")).not.toBeNull();
		f.check();
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
		releaseCompartmentLeaseBestEffort(f.db, f.sessionId, "other");
		f.check();
		expect(
			getCompartments(f.db, f.sessionId).map((row) => row.sequence),
		).toEqual([0]);
	} finally {
		f.close();
	}
});

it("narrow history checks retain legacy null ends and can retire a suffix containing one", () => {
	const f = fixture(12, 3);
	try {
		f.check();
		f.db
			.prepare(
				"UPDATE compartments SET end_message_id = NULL WHERE session_id = ? AND sequence = 2",
			)
			.run(f.sessionId);
		f.check();
		expect(
			f.db
				.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
				.get(f.sessionId),
		).toEqual({ n: 3 });
		f.db
			.prepare(
				"UPDATE compartments SET end_message_id = 'old-sibling' WHERE session_id = ? AND sequence = 1",
			)
			.run(f.sessionId);
		f.check();
		expect(
			getCompartments(f.db, f.sessionId).map((row) => row.sequence),
		).toEqual([0]);
	} finally {
		f.close();
	}
});

const benchmark = process.env.PI_HISTORY_REPAIR_BENCH === "1" ? it : it.skip;

benchmark(
	"measures append and tree history repair on 13800 messages and 1500 compartments",
	() => {
		const { dir } = createTestTempDir("pi-history-repair-bench-");
		const f = fixture(13_800, 1_500, join(dir, "fixture.sqlite"));
		f.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
		const appendSamples: number[] = [];
		const treeSamples: number[] = [];
		const cut = 6_903;
		const kept = f.compartments.filter((row) => row.endMessage <= cut).length;
		const stats = (samples: number[]) => {
			const ordered = [...samples].sort((left, right) => left - right);
			return {
				medianMs: ordered[Math.floor(ordered.length / 2)],
				p99Ms: ordered[Math.ceil(ordered.length * 0.99) - 1],
			};
		};
		try {
			f.check();
			for (let index = 0; index < 64 + 1024; index++) {
				f.append();
				const start = performance.now();
				f.check();
				const elapsed = performance.now() - start;
				if (index >= 64) appendSamples.push(elapsed);
			}
			for (let index = 0; index < 5 + 100; index++) {
				f.setBranch([...f.original]);
				f.check();
				f.setBranch(f.original.slice(0, cut));
				const start = performance.now();
				f.check();
				const elapsed = performance.now() - start;
				if (index >= 5) treeSamples.push(elapsed);
				expect(
					f.db
						.prepare(
							"SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
						)
						.get(f.sessionId),
				).toEqual({ n: kept });
				// Restore outside the measured interval so every tree sample retires
				// the same suffix rather than timing an already-repaired branch.
				appendCompartments(f.db, f.sessionId, f.compartments.slice(kept));
			}
			console.log(
				"PI_HISTORY_REPAIR_BENCH",
				JSON.stringify({
					messages: 13800,
					compartments: 1500,
					appendSamples: appendSamples.length,
					treeSamples: treeSamples.length,
					retiredPerTree: 1500 - kept,
					append: stats(appendSamples),
					tree: stats(treeSamples),
					runtime: Bun.version,
					platform: process.platform,
				}),
			);
			expect(appendSamples).toHaveLength(1024);
			expect(treeSamples).toHaveLength(100);
		} finally {
			f.close();
		}
	},
	120000,
);
