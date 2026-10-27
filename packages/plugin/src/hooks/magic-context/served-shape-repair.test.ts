import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { Database } from "../../shared/sqlite";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { hasReclaimRide, reclaimRideLabel } from "./cache-busting-signals";
import { markServedShapeRepair, prepareServedShapeRepair } from "./served-shape-repair";
import { captureInlineThinkingRepairs, stripInlineThinking } from "./strip-content";

function database() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function draft(providerID = "openai", text = "§58§"): SessionContext {
    return {
        sessionID: "poisoned",
        model: { providerID, id: "mock-model" },
        agent: "build",
        messages: [
            { id: "old", role: "assistant", content: [{ type: "text", text }] },
            { id: "error-1", role: "assistant", content: [], finish: "error" },
            { id: "error-2", role: "assistant", content: [], finish: "error" },
            { id: "retry", role: "user", content: [{ type: "text", text: "retry" }] },
        ],
        system: [],
        tools: {},
        options: {},
    };
}

describe("served-shape copied-tag decisions", () => {
    it("admits one repair rebuild, then replays the frozen literal on defer and provider switch", () => {
        const db = database();
        let previous = "";
        for (const [index, provider] of [
            "openai",
            "openai",
            "anthropic",
            "bedrock",
            "openai",
        ].entries()) {
            const context = draft(provider);
            const mapped = adaptPayload(context);
            const repair = prepareServedShapeRepair(db, context.sessionID, mapped.messages, () => [
                { info: { id: "old" }, parts: [{ type: "text", text: "" }] },
            ]);
            expect(repair.pending).toBe(index === 0);
            const signals = {
                hardFold: false,
                force: false,
                explicitFlush: false,
                publishedHistory: false,
                servedShapeRepair: repair.needsRebuild,
            };
            expect(hasReclaimRide(signals)).toBe(index === 0);
            if (index === 0) expect(reclaimRideLabel(signals)).toBe("ride=servedShapeRepair");
            repair.apply(repair.needsRebuild);
            mapped.commit();
            const bytes = JSON.stringify(context.messages);
            expect(context.messages[0].content[0].text).toBe("§58§");
            if (previous) expect(bytes).toBe(previous);
            previous = bytes;
        }
        db.close();
    });

    it("does not freeze a repair until the shared rebuild permission is granted", () => {
        const db = database();
        const context = draft();
        const mapped = adaptPayload(context);
        const repair = prepareServedShapeRepair(db, context.sessionID, mapped.messages, () => [
            { info: { id: "old" }, parts: [{ type: "text", text: "" }] },
        ]);
        expect(repair.pending).toBe(true);
        repair.apply(false);
        expect(readReplayEnvelope(db, context.sessionID).servedShapeRepair).toBeUndefined();
        repair.apply(true);
        expect(readReplayEnvelope(db, context.sessionID).servedShapeRepair).toEqual({
            old: [{ index: 0, text: "§58§" }],
        });
        db.close();
    });

    it("requires unambiguous readable evidence of a served empty slot", () => {
        const db = database();
        const mapped = adaptPayload(draft());
        const empty = { info: { id: "old" }, parts: [{ type: "text", text: "" }] };
        for (const read of [
            undefined,
            () => null,
            () => ({}) as never,
            () => {
                throw new Error("unreadable mirror");
            },
            () => [],
            () => [{ info: { id: "old" } }],
            () => [empty, empty],
            () => [{ ...empty, parts: [{ type: "text", text: " " }] }],
        ]) {
            expect(
                prepareServedShapeRepair(db, "poisoned", mapped.messages, read).needsRebuild,
            ).toBe(false);
        }
        expect(
            prepareServedShapeRepair(db, "poisoned", mapped.messages, () => [empty]).needsRebuild,
        ).toBe(true);
        db.close();
    });

    it("leaves model-authored blank framing, real prose and canonical Anthropic undecided", () => {
        const db = database();
        for (const [provider, text] of [
            ["openai", " \n\t "],
            ["openai", "§12§ done"],
            ["anthropic", "§58§"],
        ]) {
            const context = draft(provider, text);
            const mapped = adaptPayload(context);
            expect(prepareServedShapeRepair(db, context.sessionID, mapped.messages).pending).toBe(
                false,
            );
        }
        expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toBeUndefined();
        db.close();
    });

    it("does not resurrect a message intentionally dropped after repair", () => {
        const db = database();
        const context = draft();
        const mapped = adaptPayload(context);
        prepareServedShapeRepair(db, context.sessionID, mapped.messages).apply(true);
        (mapped.messages[0].parts[0] as { text: string }).text = "[dropped §1§]";
        prepareServedShapeRepair(db, context.sessionID, mapped.messages).apply(false);
        expect((mapped.messages[0].parts[0] as { text: string }).text).toBe("[dropped §1§]");
        db.close();
    });

    it("retains unrelated replay namespaces when saving the repair", () => {
        const db = database();
        updateReplayDocument(db, "poisoned", (doc) => {
            doc.version = 2;
            doc.piNative = { opaque: "signed" };
            return true;
        });
        const context = draft();
        const mapped = adaptPayload(context);
        prepareServedShapeRepair(db, "poisoned", mapped.messages).apply(true);
        expect(readReplayEnvelope(db, "poisoned").piNative).toEqual({ opaque: "signed" });
        db.close();
    });

    it("freezes fresh inline stripping only with permission and replays alongside another repaired part", () => {
        const db = database();
        const mapped = adaptPayload(draft());
        const message = mapped.messages[0];
        message.parts.push({ type: "text", text: "<thinking>private</thinking>" });
        const tags = new Map([[message, 1]]);
        const repair = prepareServedShapeRepair(db, "poisoned", mapped.messages, () => []);
        repair.apply(false);
        expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toEqual({
            old: [{ index: 0, text: "§58§" }],
        });
        stripInlineThinking(mapped.messages, tags, 1, true);
        repair.apply(false);
        expect(message.parts[1]).toEqual({ type: "text", text: "" });
        repair.apply(true);
        expect(message.parts[1]).toEqual({ type: "text", text: "[cleared]" });
        expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toEqual({
            old: [
                { index: 0, text: "§58§" },
                { index: 1, text: "[cleared]" },
            ],
        });
        message.parts[1] = { type: "text", text: "" };
        prepareServedShapeRepair(db, "poisoned", mapped.messages).apply(false);
        expect(message.parts[1]).toEqual({ type: "text", text: "[cleared]" });
        db.close();
    });

    it("does not exempt an uncommitted inline candidate from placeholder cleanup", () => {
        const db = database();
        const mapped = adaptPayload(draft("openai", "ordinary"));
        markServedShapeRepair(mapped.messages[0].info, [{ index: 0, text: "[cleared]" }], true);
        const repair = prepareServedShapeRepair(db, "poisoned", mapped.messages);
        repair.apply(false);
        expect(repair.messageIDs.has("old")).toBe(false);
        expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toBeUndefined();
        db.close();
    });

    it("captures only eligible inline-only replay sources, never prose or authored blanks", () => {
        const db = database();
        for (const [text, role, tag, cutoff, expected] of [
            ["<think>private</think>", "assistant", 1, 1, true],
            ["<thinking>private</thinking>\n ", "assistant", 1, 1, true],
            ["<think>private</think>answer", "assistant", 1, 1, false],
            ["", "assistant", 1, 1, false],
            [" \n ", "assistant", 1, 1, false],
            ["<think>private</think>", "user", 1, 1, false],
            ["<think>private</think>", "assistant", 0, 1, false],
            ["<think>private</think>", "assistant", 2, 1, false],
        ] as const) {
            const message = { info: { id: "inline", role }, parts: [{ type: "text", text }] };
            captureInlineThinkingRepairs([message], new Map([[message, tag]]), cutoff);
            expect(
                prepareServedShapeRepair(db, "poisoned", [message], () => [
                    { info: message.info, parts: [{ type: "text", text: "" }] },
                ]).needsRebuild,
            ).toBe(expected);
        }
        db.close();
    });

    it("does not freeze copied-tag replacements without conclusive prior-shape evidence on defer", () => {
        const db = database();
        const mapped = adaptPayload(draft());
        const empty = { info: { id: "old" }, parts: [{ type: "text", text: "" }] };
        for (const read of [
            undefined,
            () => null,
            () => {
                throw new Error("unreadable");
            },
            () => ({}) as never,
            () => [empty, empty],
            () => [{ info: { id: "old" } }],
            () => [{ ...empty, parts: [{ type: "text", text: "§58§" }] }],
        ]) {
            const repair = prepareServedShapeRepair(db, "poisoned", mapped.messages, read);
            repair.apply(false);
            expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toBeUndefined();
            expect(mapped.messages[0].parts[0]).toEqual({ type: "text", text: "§58§" });
        }
        db.close();
    });
});
