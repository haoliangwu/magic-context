import { expect, test } from "bun:test";
import {
	piGateCases,
	renderPiToolSurfaces,
} from "./smart-notes-dreamer-gate.fixture";
import golden from "./smart-notes-dreamer-gate.golden.json";
import { createTestDb } from "./test-utils.test";

// Smart notes are evaluated by the dreamer, so Pi's ctx_note drops its
// smart-note argument and text when the boot project's dreamer is not runnable,
// as it already did for smart_notes.enabled=false. The golden holds the tool
// bytes from before that gate, for every registration-option combination.

const SMART_NOTE_TEXT = /surface_condition|smart.note|outside checker/i;

test("Pi/OMP tool bytes match the pre-gate golden with the dreamer on, and only ctx_note changes with it off", () => {
	const db = createTestDb();
	try {
		const cases = piGateCases();
		const expected = (
			golden as { cases: Array<{ note: string; other: string }> }
		).cases;
		expect(cases).toHaveLength(48);
		expect(expected).toHaveLength(cases.length);
		let changed = 0;
		for (const [index, gateCase] of cases.entries()) {
			const got = renderPiToolSurfaces(gateCase, db);
			const before = expected[index];
			if (!before) throw new Error(`golden has no case ${index}`);
			const label = `case ${index} ${JSON.stringify(gateCase)}`;
			expect({ label, other: got.other }).toEqual({
				label,
				other: before.other,
			});
			if (gateCase.dreamerEnabled) {
				expect({ label, note: got.note }).toEqual({ label, note: before.note });
				continue;
			}
			const off = renderPiToolSurfaces(
				{ ...gateCase, dreamerEnabled: true, smartNotesEnabled: false },
				db,
			);
			expect({ label, note: got.note }).toEqual({ label, note: off.note });
			expect(got.noteText).not.toMatch(SMART_NOTE_TEXT);
			if (gateCase.smartNotesEnabled !== false) {
				changed++;
				expect(got.note).not.toBe(before.note);
			}
		}
		expect(changed).toBe(16);
	} finally {
		db.close();
	}
});
