import { expect, it } from "bun:test";
import { join } from "node:path";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { getTemporalDecisions } from "../../features/magic-context/temporal-decisions";
import { seedTemporalUpgradeFixture } from "../../shared/temporal-upgrade-fixture";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createHostSeams } from "../../v2/hooks/context";
import type { V2Context } from "../../v2/hooks/types";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";

it.each([
    "OpenCode 1",
    "OpenCode 2",
])("%s freezes user gap bytes across a cut and a restart", async (runtime) => {
    const root = createTestTempDir("temporal-replay-");
    let db = openDatabase(join(root.dir, "context.db"))!;
    const sessionId = `temporal-${runtime}`;
    const pending = new Set([sessionId]);
    const models = new Map([
        [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }],
    ]);
    const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
    const makeTransform = () =>
        createTransform({
            ...(runtime === "OpenCode 2"
                ? createHostSeams({} as V2Context, read, read, models)
                : {}),
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: pending,
            lastHeuristicsTurnId: new Map(),
            experimentalTemporalAwareness: true,
            historianRunnable: false,
            liveModelBySession: models,
            protectedTokens: 0,
        });
    const user = {
        info: { id: "user", sessionID: sessionId, role: "user", time: { created: 600_000 } },
        parts: [{ type: "text", text: "question" }],
    };
    const assistant = {
        info: { id: "prior", role: "assistant", time: { created: 100_000, completed: 300_000 } },
        parts: [{ type: "text", text: "answer" }],
    };
    try {
        const rebuilt = structuredClone([assistant, user]);
        await makeTransform()({}, { messages: rebuilt });
        expect(rebuilt[1].parts[0].text).toContain("<!-- +5m -->");
        updateSessionMeta(db, sessionId, { lastResponseTime: Date.now(), cacheTtl: "59m" });
        closeDatabase();
        db = openDatabase(join(root.dir, "context.db"))!;
        resetLkgSlotsForTest();
        const cut = structuredClone([user]);
        await makeTransform()({}, { messages: cut });
        expect(cut[0].parts[0].text).toBe(rebuilt[1].parts[0].text);
        const newUser = {
            ...structuredClone(user),
            info: { ...user.info, id: "new", time: { created: 3_600_000 } },
        };
        const defer = structuredClone([user, newUser]);
        await makeTransform()({}, { messages: defer });
        expect(defer[1].parts[0].text).not.toContain("<!-- +");
        pending.add(sessionId);
        const priced = structuredClone([user, newUser]);
        await makeTransform()({}, { messages: priced });
        expect(priced[1].parts[0].text).toContain("<!-- +50m -->");
    } finally {
        closeDatabase();
        root.cleanup();
    }
});

it.each([
    "OpenCode 1",
    "OpenCode 2",
])("%s upgrade preserves every previously served marker on the first defer", async (runtime) => {
    const root = createTestTempDir("oc-temporal-upgrade-");
    const path = join(root.dir, "context.db");
    let db = openDatabase(path)!;
    const captured = seedTemporalUpgradeFixture(db, runtime);
    const sessionId = captured.sessionId;
    const models = new Map([
        [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }],
    ]);
    const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
    const deps = () => ({
        db,
        scheduler: { shouldExecute: () => "defer" as const },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map(),
        experimentalTemporalAwareness: true,
        historianRunnable: false,
        liveModelBySession: models,
        protectedTokens: 0,
    });
    try {
        expect(captured.projectionJson).toContain("<!-- +5m -->");
        expect(captured.projectionJson).toContain("<!-- +10m -->");
        expect(getTemporalDecisions(db, sessionId).size).toBe(0);
        closeDatabase();
        db = openDatabase(path)!;
        resetLkgSlotsForTest();
        const seams =
            runtime === "OpenCode 2" ? createHostSeams({} as V2Context, read, read, models) : {};
        const continued = structuredClone(captured.input);
        await createTransform({ ...seams, ...deps(), tagger: createTagger() })(
            {},
            { messages: continued },
        );
        expect(JSON.stringify(continued)).toBe(captured.projectionJson);
        expect(getTemporalDecisions(db, sessionId).get("user")).toBe("<!-- +5m -->\n");
        expect(getTemporalDecisions(db, sessionId).get("later")).toBe("<!-- +10m -->\n");
    } finally {
        closeDatabase();
        root.cleanup();
    }
});
