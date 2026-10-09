import { expect, it } from "bun:test";
import { join } from "node:path";
import mode from "../../../../../testdata/temporal-mode-switch.json";
import shared from "../../../../../testdata/temporal-session-parity.json";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    addStaleReduceStrippedIds,
    getOrCreateSessionMeta,
    insertTag,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
} from "../../features/magic-context/temporal-decisions";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { buildModuleStateSyncPayload } from "./module-state-sync";
import { encodeOpenCodeMessagesToCk } from "./module-wire";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createTransform } from "./transform";

async function modeSwitchSeed(temporal: boolean): Promise<void> {
    const root = createTestTempDir("temporal-mode-seed-");
    const db = new Database(join(root.dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    try {
        const id = "mode-switch";
        getOrCreateSessionMeta(db, id);
        insertTag(db, id, "user:p0", "message", 10, 1);
        addStaleReduceStrippedIds(db, id, ["user"]);
        if (temporal) freezeTemporalDecisions(db, id, new Map([["user", "<!-- +17m -->\n"]]));
        const payload = await buildModuleStateSyncPayload({
            state: {
                moduleGeneration: 1,
                lastAckedSeq: 0,
                lastAckedWatermarks: null,
                idOrdinalMemoGeneration: 1,
                idOrdinalMemo: new Map(),
                seedPassPending: true,
            },
            pass: { db, sessionId: id, nowMs: 1_000 },
            force: true,
            seedId: "fixed-mode-seed",
        });
        expect(payload).toBeObject();
        const wire = JSON.stringify(payload);
        expect(wire).toContain('"strip_kind":"stale_reduce"');
        expect(wire).toContain('"message_id":"user"');
        if (temporal) {
            // No transfer is promised: the switch pays for the new renderer's
            // first choice, while the old engine retains its own authority.
            expect(wire).not.toContain("<!-- +17m -->");
            expect(getTemporalDecisions(db, id).get("user")).toBe("<!-- +17m -->\n");
        }
    } finally {
        closeReadOnlySessionDb();
        db.close();
        root.cleanup();
    }
}

it("control: Rust mode-switch state-sync transports TS frozen strip choices", () =>
    modeSwitchSeed(false));
it("Rust mode-switch seed leaves temporal choices engine-owned", () => modeSwitchSeed(true));

it("TS mode-switch rebuild retains its own frozen choice and subsequent defers are stable", async () => {
    const root = createTestTempDir("temporal-mode-ts-");
    const db = new Database(join(root.dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    resetLkgSlotsForTest();
    const id = mode.request.session_id;
    try {
        const pending = new Set([id]);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: pending,
            lastHeuristicsTurnId: new Map(),
            experimentalTemporalAwareness: true,
            historianRunnable: false,
            liveModelBySession: new Map([
                [id, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }],
            ]),
            protectedTokens: 0,
            clearReasoningAge: 0,
        });
        const raw = shared.messages.map((row) => ({
            info: {
                id: row.id,
                sessionID: id,
                role: row.role,
                time: { created: row.created, completed: row.completed },
            },
            parts: [{ type: "text", text: row.text }],
        }));
        const users = (messages: typeof raw) =>
            messages
                .filter((message) => message.info.role === "user")
                .map((message) => message.parts[0].text);
        const first = structuredClone(raw);
        await transform({}, { messages: first });
        expect(users(first)).toEqual(mode.ts_users);
        updateSessionMeta(db, id, { lastResponseTime: Date.now(), cacheTtl: "59m" });
        raw[0].info.time.completed = 0;
        expect(encodeOpenCodeMessagesToCk(raw)).toEqual(mode.request.messages);
        // Returning to TS is explicitly priced, not a claim of equality with
        // what the cold Rust engine chose on its own rebuilding pass.
        pending.add(id);
        const switched = structuredClone(raw);
        await transform({}, { messages: switched });
        expect(users(switched)).toEqual(mode.ts_users);
        raw[0].info.time.completed = 600_000;
        for (let pass = 0; pass < 3; pass++) {
            const replay = structuredClone(raw);
            await transform({}, { messages: replay });
            expect(users(replay)).toEqual(users(switched));
        }
        expect(getTemporalDecisions(db, id).get("user")).toBe("<!-- +5m -->\n");
    } finally {
        resetLkgSlotsForTest();
        db.close();
        root.cleanup();
    }
});
