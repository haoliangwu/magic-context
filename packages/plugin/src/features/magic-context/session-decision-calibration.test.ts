/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { CALIBRATION_TABLE_REVISION } from "../../hooks/magic-context/tokenizer-calibration";
import { Database } from "../../shared/sqlite";
import {
    HYGIENE_PROVIDER_UNITS_VERSION,
    sessionDecisionCalibration,
    sessionHygieneUnitsVersion,
    transitionSessionHygieneUnits,
} from "./session-decision-calibration";

function createDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            cached_m0_model_key TEXT,
            last_observed_model_key TEXT,
            deferred_execute_state TEXT,
            last_nudge_undropped INTEGER DEFAULT 0,
            last_nudge_level TEXT DEFAULT ''
        )
    `);
    return db;
}

function protectedCount(ratio: number): { count: number; cutoff: number } {
    let count = 3;
    while (count < 40 && Math.ceil(count * 1_000 * ratio) < 30_000) count += 1;
    return { count, cutoff: 41 - count };
}

function frozenFableState(): string {
    return JSON.stringify({
        unrelatedLegacyKey: { retained: true },
        magicContextTokenizerCalibration: {
            active: {
                revision: "frozen-family-v1",
                providerId: "anthropic",
                modelId: "claude-fable-5-1",
                systemRatio: 1.511497,
                toolsRatio: 1.551639,
                proseRatio: 1.571778,
                source: "seed",
            },
        },
    });
}

describe("session decision calibration freeze", () => {
    it("replays the frozen revision across defer restart and adopts the table only on bust", () => {
        const db = createDb();
        db.prepare(
            "INSERT INTO session_meta (session_id, cached_m0_model_key, deferred_execute_state) VALUES (?, ?, ?)",
        ).run("session", "unknown/new-model", frozenFableState());

        const firstDefer = sessionDecisionCalibration(db, "session");
        const restartedDefer = sessionDecisionCalibration(db, "session");
        expect(firstDefer.revision).toBe("frozen-family-v1");
        expect(restartedDefer.revision).toBe("frozen-family-v1");
        expect(protectedCount(firstDefer.toolsRatio)).toEqual({ count: 20, cutoff: 21 });
        expect(protectedCount(restartedDefer.toolsRatio)).toEqual({ count: 20, cutoff: 21 });

        const logs: string[] = [];
        const bust = sessionDecisionCalibration(db, "session", {
            bustPermitted: true,
            modelKey: "unknown/new-model",
            bustReason: "force",
            onAdopt: (message) => logs.push(message),
        });
        expect(bust.revision).toBe(CALIBRATION_TABLE_REVISION);
        expect(protectedCount(bust.toolsRatio)).toEqual({ count: 30, cutoff: 11 });
        expect(logs).toEqual([
            `calibration revision frozen-family-v1 → ${CALIBRATION_TABLE_REVISION} adopted (bust=force)`,
        ]);

        const persisted = JSON.parse(
            db
                .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
                .get("session")!.deferred_execute_state as string,
        );
        expect(persisted.unrelatedLegacyKey).toEqual({ retained: true });
    });

    it("keeps v1 watermarks on defer then converts them exactly once on the priced pass", () => {
        const db = createDb();
        db.prepare(
            "INSERT INTO session_meta (session_id, cached_m0_model_key, deferred_execute_state, last_nudge_undropped, last_nudge_level) VALUES (?, ?, ?, ?, ?)",
        ).run(
            "session",
            "anthropic/claude-fable-5-1",
            frozenFableState(),
            20_000,
            JSON.stringify({
                level: "firm",
                ordinal: 4,
                postReduceGraceBaselineU: 10_000,
            }),
        );
        const calibration = sessionDecisionCalibration(db, "session");

        expect(transitionSessionHygieneUnits(db, "session", false, calibration)).toBe(1);
        let row = db
            .prepare(
                "SELECT last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id = ?",
            )
            .get("session")! as { last_nudge_undropped: number; last_nudge_level: string };
        expect(row.last_nudge_undropped).toBe(20_000);
        expect(JSON.parse(row.last_nudge_level).postReduceGraceBaselineU).toBe(10_000);

        expect(transitionSessionHygieneUnits(db, "session", true, calibration)).toBe(
            HYGIENE_PROVIDER_UNITS_VERSION,
        );
        row = db
            .prepare(
                "SELECT last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id = ?",
            )
            .get("session")! as { last_nudge_undropped: number; last_nudge_level: string };
        expect(row.last_nudge_undropped).toBe(31_033);
        expect(JSON.parse(row.last_nudge_level).postReduceGraceBaselineU).toBe(15_516);
        expect(sessionHygieneUnitsVersion(db, "session")).toBe(2);

        transitionSessionHygieneUnits(db, "session", true, calibration);
        const second = db
            .prepare(
                "SELECT last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id = ?",
            )
            .get("session")! as { last_nudge_undropped: number; last_nudge_level: string };
        expect(second.last_nudge_undropped).toBe(31_033);
        expect(JSON.parse(second.last_nudge_level).postReduceGraceBaselineU).toBe(15_516);
    });
});
