import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta, initializeDatabase } from "../../features/magic-context/storage";
import {
    appendAutoSearchHintDecision,
    appendNoteNudgeAnchor,
    getNoteNudgeAnchors,
} from "../../features/magic-context/storage-meta-persisted";
import { addNote } from "../../features/magic-context/storage-notes";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { createHostSeams } from "../../v2/hooks/context";
import type { V2Context } from "../../v2/hooks/types";
import { onNoteTrigger } from "./note-nudger";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";
import { runRustModePostprocess } from "./transform-postprocess-phase";

const databases: Database[] = [];
const roots: string[] = [];
const oldData = process.env.XDG_DATA_HOME;
const oldCache = process.env.XDG_CACHE_HOME;
const now = 1_800_000_000_000;
const hint = "\n\n<ctx-search-hint>frozen review recall</ctx-search-hint>";
const note = '\n\n<instruction name="deferred_notes">frozen review note</instruction>';

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    clearModelsDevCache();
    for (const db of databases.splice(0)) db.close();
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
    if (oldData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldData;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
});

function database(path = ":memory:") {
    const { dir: root } = createTestTempDir("note-nudge-review-");
    roots.push(root);
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_CACHE_HOME = root;
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function user(id: string, text = id): MessageLike {
    return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function thinking(id: string): MessageLike {
    return {
        info: { id, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5-5" },
        parts: [
            {
                type: "reasoning",
                text: `thought ${id}`,
                metadata: { anthropic: { signature: id } },
            },
            { type: "text", text: `answer ${id}` },
        ],
    };
}

function fixture(sessionId: string, generation: "v1" | "v2" = "v1", db = database()) {
    getOrCreateSessionMeta(db, sessionId);
    const usage = new Map<
        string,
        { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
    >();
    const models = new Map([[sessionId, { providerID: "anthropic", modelID: "claude-opus-5-5" }]]);
    const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
    const makeTransform = () =>
        createTransform({
            ...(generation === "v2" ? createHostSeams({} as V2Context, read, read, models) : {}),
            db,
            directory: process.cwd(),
            memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true },
            storeGeneration: generation,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: models,
            contextUsageMap: usage,
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
    let transform = makeTransform();
    const raw = [user("warm")];
    const serve = async () => {
        const messages = structuredClone(raw);
        for (const message of messages) message.info.sessionID = sessionId;
        await transform({}, { messages });
        return messages;
    };
    return {
        db,
        raw,
        serve,
        usage,
        restart: () => {
            transform = makeTransform();
        },
    };
}

function record(host: string, seed: number, pass: number, messages: unknown) {
    if (process.env.NUDGE_REVIEW_OUTPUT) {
        appendFileSync(
            process.env.NUDGE_REVIEW_OUTPUT,
            `${JSON.stringify({ host, seed, pass, bytes: JSON.stringify(messages) })}\n`,
        );
    }
}

describe("independent note-nudge cache review", () => {
    for (const generation of ["v1", "v2"] as const) {
        for (const seed of [17, 2027, 0x5eed]) {
            it(`${generation} no-pending differential seed ${seed}: 48 passes`, async () => {
                const clock = spyOn(Date, "now").mockReturnValue(now);
                try {
                    let state = seed;
                    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
                    const f = fixture(`review-diff-${generation}-${seed}`, generation);
                    for (let pass = 0; pass < 48; pass++) {
                        if (pass > 0 && pass % 3 === 0)
                            f.raw.push(user(`user-${pass}`, `prompt ${next()}`));
                        else if (pass % 3 === 1) f.raw.push(thinking(`thought-${pass}-${next()}`));
                        const percentage = [20, 64, 70, 86][next() % 4];
                        f.usage.set(`review-diff-${generation}-${seed}`, {
                            usage: { percentage, inputTokens: Math.round(percentage * 1000) },
                            updatedAt: now,
                            hasUsageTokens: true,
                        });
                        const messages = await f.serve();
                        const bytes = JSON.stringify(messages);
                        expect(bytes).not.toContain("deferred_notes");
                        expect(bytes).not.toContain("ctx-search-hint");
                        expect(messages.length).toBeGreaterThan(0);
                        expect(bytes).toContain("§1§");
                        record(generation, seed, pass, messages);
                        if (pass === 24) f.restart();
                    }
                } finally {
                    clock.mockRestore();
                }
            }, 30000);
        }

        it(`${generation} note/hint bytes survive 48 replays and transform restart`, async () => {
            const sessionId = `review-replay-${generation}`;
            const { dir: root } = createTestTempDir("note-nudge-review-oc-reopen-");
            roots.push(root);
            const path = join(root, "db.sqlite");
            let f = fixture(sessionId, generation, database(path));
            await f.serve();
            f.raw.push(user("anchor"));
            appendAutoSearchHintDecision(f.db, sessionId, {
                messageId: "anchor",
                decision: "hint",
                text: hint,
            });
            addNote(f.db, "session", { sessionId, content: "Deferred review task" });
            onNoteTrigger(f.db, sessionId, "commit_detected");
            const first = await f.serve();
            const region = JSON.stringify(first.find((m) => m.info.id === "anchor"));
            expect(region).toContain("deferred_notes");
            expect(region.indexOf("deferred_notes")).toBeLessThan(
                region.indexOf("ctx-search-hint"),
            );
            for (let pass = 0; pass < 48; pass++) {
                if (pass === 24) {
                    const raw = f.raw;
                    databases.splice(databases.indexOf(f.db), 1);
                    f.db.close();
                    f = fixture(sessionId, generation, database(path));
                    f.raw.splice(0, f.raw.length, ...raw);
                }
                f.raw.push(thinking(`step-${pass}`));
                expect(JSON.stringify((await f.serve()).find((m) => m.info.id === "anchor"))).toBe(
                    region,
                );
            }
        }, 30000);

        it(`${generation} legacy upgrade capture records first delivery and saved replay`, async () => {
            const clock = spyOn(Date, "now").mockReturnValue(now);
            try {
                const sessionId = `review-legacy-capture-${generation}`;
                const f = fixture(sessionId, generation);
                await f.serve();
                f.raw.push(user("legacy-anchor"));
                appendAutoSearchHintDecision(f.db, sessionId, {
                    messageId: "legacy-anchor",
                    decision: "hint",
                    text: hint,
                });
                addNote(f.db, "session", { sessionId, content: "Legacy capture note" });
                onNoteTrigger(f.db, sessionId, "historian_complete");
                for (let pass = 0; pass < 2; pass++) {
                    const region = (await f.serve()).find((m) => m.info.id === "legacy-anchor");
                    expect(JSON.stringify(region)).toContain("deferred_notes");
                    expect(JSON.stringify(region)).toContain("ctx-search-hint");
                    record(`legacy-${generation}`, 0, pass, region);
                }
            } finally {
                clock.mockRestore();
            }
        });
    }

    it("stored legacy anchors cannot retain the anomalous hint-before-note wire order", () => {
        const db = database();
        const sessionId = "review-legacy-anomaly";
        getOrCreateSessionMeta(db, sessionId);
        appendAutoSearchHintDecision(db, sessionId, {
            messageId: "legacy",
            decision: "hint",
            text: hint,
        });
        appendNoteNudgeAnchor(db, sessionId, "legacy", note);
        const messages = [user("legacy", "original prompt")];
        runRustModePostprocess({ db, sessionId, messages, fullFeatureMode: true });
        const bytes = JSON.stringify(messages);
        expect(bytes).toContain("deferred_notes");
        expect(bytes).toContain("ctx-search-hint");
        expect(bytes).not.toBe(JSON.stringify([user("legacy", `original prompt${hint}${note}`)]));
        expect(bytes.indexOf("deferred_notes")).toBeLessThan(bytes.indexOf("ctx-search-hint"));
    });

    it("Rust host waits 48 signed-loop passes, delivers on the first fresh user, and reopens cleanly", () => {
        const { dir: root } = createTestTempDir("note-nudge-review-restart-");
        roots.push(root);
        const path = join(root, "db.sqlite");
        let db = database(path);
        const sessionId = "review-rust-liveness";
        getOrCreateSessionMeta(db, sessionId);
        const raw = [user("old"), thinking("kept")];
        const serve = () => {
            const messages = structuredClone(raw);
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: true,
                cacheBustingPass: true,
            });
            return messages;
        };
        const first = serve();
        addNote(db, "session", { sessionId, content: "Eventually deliver" });
        onNoteTrigger(db, sessionId, "historian_complete");
        for (let pass = 0; pass < 48; pass++) expect(serve()).toEqual(first);
        expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(0);
        raw.push(user("fresh"));
        appendAutoSearchHintDecision(db, sessionId, {
            messageId: "fresh",
            decision: "hint",
            text: hint,
        });
        const delivered = serve();
        expect(delivered.slice(0, 2)).toEqual(first);
        expect(JSON.stringify(delivered.at(-1))).toContain("deferred_notes");
        expect(serve()).toEqual(delivered);
        databases.splice(databases.indexOf(db), 1);
        db.close();
        db = database(path);
        expect(serve()).toEqual(delivered);
    });
});
