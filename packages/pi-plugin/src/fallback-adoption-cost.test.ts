import { expect, it, spyOn } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { __test } from "./context-handler";
import { createTestDb } from "./test-utils.test";

it("unmatchable historical fallback tags use bounded fingerprint probes", () => {
	const db = createTestDb();
	try {
		db.prepare(
			"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size, entry_fingerprint) VALUES ('pi-msg-old:p0', 'message', 'active', 'session', 1, 0, 'orphan')",
		).run();
		const fingerprints = new Map(
			Array.from({ length: 2400 }, (_, i) => [`entry-${i}`, `fp-${i}`]),
		);
		const prepare = spyOn(db, "prepare");
		try {
			__test.adoptPiFallbackTags(db, "session", createTagger(), fingerprints);
			const probes = prepare.mock.calls.filter(([sql]) =>
				sql.includes("entry_fingerprint"),
			);
			expect(probes).toHaveLength(3);
		} finally {
			prepare.mockRestore();
		}
		expect(db.prepare("SELECT message_id FROM tags").get()).toEqual({
			message_id: "pi-msg-old:p0",
		});
	} finally {
		db.close();
	}
});

it("a newly resolvable fallback is adopted without probing every historical message", () => {
	const db = createTestDb();
	try {
		db.prepare(
			"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size, entry_fingerprint) VALUES ('pi-msg-new:p0', 'message', 'dropped', 'session', 1, 0, 'fp-2399')",
		).run();
		const fingerprints = new Map(
			Array.from({ length: 2400 }, (_, i) => [`entry-${i}`, `fp-${i}`]),
		);
		const prepare = spyOn(db, "prepare");
		try {
			__test.adoptPiFallbackTags(db, "session", createTagger(), fingerprints);
			expect(
				prepare.mock.calls.filter(([sql]) => sql.includes("entry_fingerprint"))
					.length,
			).toBeLessThan(15);
		} finally {
			prepare.mockRestore();
		}
		expect(
			db.prepare("SELECT message_id, status, tag_number FROM tags").get(),
		).toEqual({
			message_id: "entry-2399:p0",
			status: "dropped",
			tag_number: 1,
		});
	} finally {
		db.close();
	}
});
