import { spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionContext, V2Context } from "../../../v2/hooks/types";

const [mode, sourceOrLeft, outputOrRight, host] = Bun.argv.slice(2);
assert(
    sourceOrLeft && outputOrRight,
    "capture <source> <output> <host> | compare <base-output> <target-output>",
);
if (mode === "compare") {
    let bytes = 0;
    for (const kind of ["opencode1", "opencode2", "pi"]) {
        for (let pass = 0; pass < 4; pass++) {
            const name = `${kind}-${pass}.wire`;
            const before = readFileSync(join(sourceOrLeft, name));
            const after = readFileSync(join(outputOrRight, name));
            assert.deepEqual(after, before, `${kind} pass ${pass} served bytes`);
            bytes += after.length;
            console.log(`IDENTICAL ${kind} pass ${pass}: ${after.length} bytes`);
        }
    }
    console.log(`12/12 served arrays byte-identical (${bytes} bytes)`);
} else {
    assert.equal(mode, "capture");
    assert(["opencode1", "opencode2", "pi"].includes(host));
    const output = resolve(outputOrRight);
    const sandbox = process.env.MAGIC_CONTEXT_REVIEW_FIXTURE_ROOT ?? output;
    mkdirSync(output, { recursive: true });
    mkdirSync(sandbox, { recursive: true });
    for (const name of [
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "MAGIC_CONTEXT_TEST_DATA_DIR",
    ])
        process.env[name] = sandbox;
    process.env.MAGIC_CONTEXT_LOG_PATH = join(sandbox, `${host}.log`);
    process.env.OPENCODE_DB = join(sandbox, `${host}-host.db`);
    process.env.NODE_ENV = "test";
    Date.now = () => 1_791_114_000_000;
    const load = (path: string) => import(join(resolve(sourceOrLeft), path));
    const core = "packages/plugin/src/";
    const { Database } = await load(`${core}shared/sqlite.ts`);
    const { initializeDatabase, openDatabase, closeDatabase } = await load(
        `${core}features/magic-context/storage-db.ts`,
    );
    const { runMigrations } = await load(`${core}features/magic-context/migrations.ts`);
    const { setHarness } = await load(`${core}shared/harness.ts`);
    const { createTagger } = await load(`${core}features/magic-context/tagger.ts`);
    const { replaceAllCompartments } = await load(
        `${core}features/magic-context/compartment-storage.ts`,
    );
    const { setRawMessageProvider } = await load(
        `${core}hooks/magic-context/read-session-chunk.ts`,
    );
    setHarness(host === "opencode1" ? "opencode" : host);
    const db =
        host === "opencode2" ? openDatabase(join(sandbox, "context.db")) : new Database(":memory:");
    assert(db, "synthetic context store opened");
    if (host !== "opencode2") {
        initializeDatabase(db);
        runMigrations(db);
    }
    let seed = 20261014;
    const text = (i: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (
            `source ${i} α%_ ${seed.toString(16)} ` +
            "deterministic coding material ".repeat((i % 7) + 1)
        );
    };
    const raw = Array.from({ length: 904 }, (_, i) => ({
        info: {
            id: `msg-${i}`,
            role: i % 2 ? "assistant" : "user",
            sessionID: "synthetic-review",
            time: { created: i + 1 },
            finish: "stop",
        },
        parts: [{ type: "text", text: text(i) }],
    }));
    if (host === "opencode1") {
        const { createTransform } = await load(`${core}hooks/magic-context/transform.ts`);
        replaceAllCompartments(db, "synthetic-review", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 600,
                startMessageId: "msg-0",
                endMessageId: "msg-599",
                title: "Restored history",
                content: "Seeded restored summary",
            },
        ]);
        const messages = raw.map((m, i) => ({
            id: m.info.id,
            role: m.info.role,
            parts: m.parts,
            ordinal: i + 1,
            createdAt: i + 1,
        }));
        const unregister = setRawMessageProvider("synthetic-review", {
            readMessages: () => messages,
            readMessageOrdinalById: (id: string) =>
                messages.find((m) => m.id === id)?.ordinal ?? null,
        });
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            directory: sandbox,
            injectDocs: false,
            memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
            historyRefreshSessions: new Set(),
            deferredHistoryRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historianRunnable: false,
        });
        for (let pass = 0; pass < 4; pass++) {
            const served = { messages: structuredClone(raw.slice(0, 901 + pass)) };
            await transform({}, served);
            assert(
                served.messages.some((m) => m.info.id !== "msg-0"),
                "served corpus is nonempty",
            );
            writeFileSync(join(output, `${host}-${pass}.wire`), JSON.stringify(served.messages));
        }
        unregister();
        transform.disposeRust();
    } else if (host === "pi") {
        const { registerPiContextHandler } = await load(
            "packages/pi-plugin/src/context-handler.ts",
        );
        const { createFakePi, fakeContext, userMessage, assistantMessage } = await load(
            "packages/pi-plugin/src/test-utils.test.ts",
        );
        const fake = createFakePi();
        registerPiContextHandler(fake.pi, {
            db,
            scheduler: { executeThresholdPercentage: 95 },
            injection: {
                memoryEnabled: false,
                injectDocs: false,
                injectionBudgetTokens: 4000,
                temporalAwareness: false,
            },
        });
        const handler = fake.handlers.get("context");
        assert(handler, "Pi context hook registered");
        for (let pass = 0; pass < 4; pass++) {
            const messages = raw
                .slice(0, 901 + pass)
                .map((m, i) =>
                    i % 2
                        ? assistantMessage(m.parts[0].text, i + 1)
                        : userMessage(m.parts[0].text, i + 1),
                );
            const ids = messages.map((_: unknown, i: number) => `entry-${i}`);
            const result = await handler(
                { messages },
                fakeContext("synthetic-review", sandbox, ids, messages),
            );
            assert(result?.messages, "Pi context hook served messages");
            const error = db
                .prepare(
                    "SELECT last_transform_error AS error FROM session_meta WHERE session_id='synthetic-review'",
                )
                .get();
            assert(!error?.error, `Pi hook failed open: ${error?.error}`);
            writeFileSync(join(output, `${host}-${pass}.wire`), JSON.stringify(result.messages));
        }
    } else {
        // Use the registered OpenCode 2 context hook and its payload adapter.
        // Only configuration and storage discovery are supplied by the fixture.
        const configModule = await load(`${core}config/index.ts`);
        const { MagicContextConfigSchema } = await load(`${core}config/schema/magic-context.ts`);
        const storageGate = await load(`${core}v2/hooks/storage-gate.ts`);
        const { registerContext } = await load(`${core}v2/hooks/context.ts`);
        const config = MagicContextConfigSchema.parse({
            historian: { disable: true },
            dreamer: { disable: true, inject_docs: false },
            memory: { enabled: false, auto_search: { enabled: false } },
            temporal_awareness: false,
            compressor: { enabled: false },
        });
        const configSpy = spyOn(configModule, "loadPluginConfigDetailed").mockReturnValue({
            config,
        });
        const gateSpy = spyOn(storageGate, "createV2StorageGate").mockReturnValue({
            current: () => db,
            probe: async () => db,
            require: () => db,
            reason: () => null,
        });
        const store = new Database(process.env.OPENCODE_DB);
        store.exec(
            "CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT NOT NULL)",
        );
        store.close();
        let hook: ((draft: SessionContext) => Promise<void>) | undefined;
        const context = {
            location: { directory: sandbox },
            agent: { transform: async () => {}, reload: async () => {} },
            model: { list: () => [] },
            storage: { get: async () => undefined, set: async () => {} },
            event: { subscribe: async function* () {} },
            tool: { hook: async () => {}, transform: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                interrupt: async () => {
                    throw Error("unexpected refusal");
                },
                wait: async () => {},
                get: async () => ({ location: { directory: sandbox } }),
                hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                    if (name === "context") hook = callback;
                },
            },
        } as unknown as V2Context;
        const duties = await registerContext(context);
        try {
            assert(hook, "OpenCode 2 context hook registered");
            for (let pass = 0; pass < 4; pass++) {
                const draft: SessionContext = {
                    sessionID: "synthetic-review",
                    agent: "build",
                    model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
                    system: [],
                    options: {},
                    tools: { read: { description: "Read fixture", input: { type: "object" } } },
                    messages: raw.slice(0, 901 + pass).map((m) => ({
                        id: m.info.id,
                        role: m.info.role,
                        content: structuredClone(m.parts),
                    })),
                };
                await hook(draft);
                writeFileSync(join(output, `${host}-${pass}.wire`), JSON.stringify(draft));
            }
        } finally {
            await duties?.dispose();
            configSpy.mockRestore();
            gateSpy.mockRestore();
        }
    }
    if (host === "opencode2") closeDatabase();
    else db.close();
    console.log(`Captured 4 ${host} served arrays, corpus seed 20261014`);
}
