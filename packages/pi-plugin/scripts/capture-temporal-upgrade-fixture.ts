import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { temporalLegacyTree } from "./temporal-legacy-tree";

// This manual generator needs the old Git object; the generated tests do not.
const repository = resolve(import.meta.dir, "../../..");
const base = join(tmpdir(), "magic-context/temporal-fixture-capture");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(join(base, "capture-")));
process.env.HOME = root;
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR"]) {
    process.env[key] = join(root, key);
    mkdirSync(process.env[key]!, { recursive: true });
}
process.env.OPENCODE_DB = join(root, "opencode.db");
process.env.TMPDIR = root;
const tree = temporalLegacyTree(repository);
const load = (path: string): Promise<any> => import(join(tree, path));
const core = "packages/plugin/src/";
const pi = "packages/pi-plugin/src/";
// A nonexistent logical directory makes the projection independent of the
// capture checkout's absolute path and cannot contribute project docs or files.
const cwd = "/__magic_context_temporal_upgrade_fixture__";
const now = Date.UTC(2026, 9, 5, 19, 29);
const realNow = Date.now;
Date.now = () => now;

type Value = null | string | number | { base64: string };
function captureState(db: any, sessionId: string): Record<string, Array<Record<string, Value>>> {
    const state: Record<string, Array<Record<string, Value>>> = {};
    for (const table of ["session_meta", "tags", "source_contents", "compression_depth", "session_projects", "lkg_slots", "lkg_slot_chunks"]) {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE session_id=?`).all(sessionId);
        state[table] = rows.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { base64: Buffer.from(value).toString("base64") } : value])));
    }
    return state;
}
const cases: Record<string, unknown> = {};
try {
    const old = await load(pi + "context-handler.ts");
    const utils = await load(pi + "test-utils.test.ts");
    const storage = await load(core + "features/magic-context/storage.ts");
    const sessionId = "pi-temporal-upgrade";
    const db = utils.createTestDb(":memory:");
    try {
        const input = [utils.assistantMessage("answer", 300_000), utils.userMessage("question", 600_000), utils.userMessage("follow up", 1_200_000)];
        const entryIds = ["prior", "user", "later"];
        const fake = utils.createFakePi();
        old.registerPiContextHandler(fake.pi, { db, protectedTags: 0, heuristics: {}, injection: { injectionBudgetTokens: 10_000, temporalAwareness: true } });
        const messages = structuredClone(input);
        const served = await fake.handlers.get("context")({ messages }, utils.fakeContext(sessionId, cwd, entryIds, messages));
        await new Promise<void>((done) => setImmediate(done));
        storage.updateSessionMeta(db, sessionId, { lastResponseTime: now, cacheTtl: "59m", lastContextPercentage: 1, lastInputTokens: 100 });
        cases.Pi = { sessionId, cwd, input, entryIds, projection: served.messages, projectionJson: JSON.stringify(served.messages), state: captureState(db, sessionId) };
        old.clearContextHandlerSession(sessionId);
    } finally { db.close(); }

    const transform = await load(core + "hooks/magic-context/transform.ts");
    const tagger = await load(core + "features/magic-context/tagger.ts");
    for (const runtime of ["OpenCode 1", "OpenCode 2"]) {
        const id = `upgrade-${runtime}`;
        const db = storage.openDatabase(join(root, runtime.replaceAll(" ", "-") + ".db"));
        try {
            const input = [
                { info: { id: "prior", sessionID: id, role: "assistant", time: { created: 100_000, completed: 300_000 } }, parts: [{ type: "text", text: "answer" }] },
                { info: { id: "user", sessionID: id, role: "user", time: { created: 600_000 } }, parts: [{ type: "text", text: "question" }] },
                { info: { id: "later", sessionID: id, role: "user", time: { created: 1_200_000 } }, parts: [{ type: "text", text: "follow up" }] },
            ];
            const models = new Map([[id, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }]]);
            const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
            const seams = runtime === "OpenCode 2" ? (await load(core + "v2/hooks/context.ts")).createHostSeams({}, read, read, models) : {};
            const messages = structuredClone(input);
            await transform.createTransform({ ...seams, db, tagger: tagger.createTagger(), scheduler: { shouldExecute: () => "defer" }, contextUsageMap: new Map(), historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set([id]), lastHeuristicsTurnId: new Map(), experimentalTemporalAwareness: true, historianRunnable: false, liveModelBySession: models, protectedTokens: 0 })({}, { messages });
            await new Promise<void>((done) => setImmediate(done));
            storage.updateSessionMeta(db, id, { lastResponseTime: now, cacheTtl: "59m" });
            cases[runtime] = { sessionId: id, input, projection: messages, projectionJson: JSON.stringify(messages), state: captureState(db, id) };
        } finally { storage.closeDatabase(); }
    }
    const file = resolve(repository, "testdata/temporal-upgrade-projections.json");
    writeFileSync(file, JSON.stringify({ schema: 1, sourceCommit: "114e9ff617a1f492b1baf546b52a93585eb4cfeb", capturedAt: now, projectionFormat: "exact Magic Context context-hook output before host SDK conversion", cases }, null, 2) + "\n");
    console.log(`Captured 3 historical projections to ${file}`);
} finally { Date.now = realNow; }
