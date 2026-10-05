#!/usr/bin/env bun
/**
 * Run ONE real transform pass against a shared context database, optionally
 * parking mid-pass so a second process can run against the same session.
 *
 * The park point is inside the tag walk: after the pass has selected its tool
 * sweep policy and before the sweep is finalized into the served array. That is
 * the window where a second process committing the adoption marker could
 * otherwise make one pass serve a mixture of pre- and post-adoption bytes.
 *
 * Config arrives as one JSON argument:
 *   { dataHome, sessionId, decision, out, barrierDir?, role? }
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(process.argv[2] ?? "{}") as {
    dataHome: string;
    sessionId: string;
    decision: "execute" | "defer";
    out: string;
    barrierDir?: string;
    role?: string;
};

process.env.XDG_DATA_HOME = config.dataHome;
process.env.XDG_CONFIG_HOME = join(config.dataHome, "config");

const { openDatabase } = await import("../../plugin/src/features/magic-context/storage");
const { createTagger } = await import("../../plugin/src/features/magic-context/tagger");
const { createDbLkgPersistence } = await import("../../plugin/src/hooks/magic-context/lkg-persist");
const { registerLkgPersistence } = await import("../../plugin/src/hooks/magic-context/lkg-slot");
const { createTransform } = await import("../../plugin/src/hooks/magic-context/transform");

type TestMessage = { info: Record<string, unknown>; parts: Record<string, unknown>[] };

function park(): void {
    if (!config.barrierDir || !config.role) return;
    writeFileSync(join(config.barrierDir, `${config.role}.parked`), "parked");
    const release = join(config.barrierDir, `${config.role}.go`);
    const deadline = Date.now() + 60_000;
    while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error(`barrier timeout for ${config.role}`);
        Bun.sleepSync(20);
    }
}

const db = openDatabase();
if (!db) throw new Error("context database unavailable");
// The plugin registers this at boot; without it a fresh process cannot read the
// durable record of what this session was last served.
registerLkgPersistence(createDbLkgPersistence(db));
const realTagger = createTagger();
let parked = false;
const tagger = new Proxy(realTagger, {
    get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const method = value.bind(target) as (...args: unknown[]) => unknown;
        // getAssignments runs inside the tag walk, after the pass read its
        // sweep policy and before the batch that applies it is finalized.
        if (property !== "getAssignments") return method;
        return (...args: unknown[]) => {
            if (!parked) {
                parked = true;
                park();
            }
            return method(...args);
        };
    },
});

const transform = createTransform({
    tagger,
    scheduler: { shouldExecute: () => config.decision },
    contextUsageMap: new Map(),
    db,
    historyRefreshSessions: new Set(),
    pendingMaterializationSessions: new Set(),
    lastHeuristicsTurnId: new Map(),
    clearReasoningAge: 1000,
    protectedTokens: 0,
    historianRunnable: false,
    liveModelBySession: new Map([
        [config.sessionId, { providerID: "anthropic", modelID: "claude-opus-5" }],
    ]),
});

const source: TestMessage[] = [
    {
        info: { id: "cc-user", role: "user", sessionID: config.sessionId },
        parts: [{ type: "text", text: "start" }],
    },
    {
        info: { id: "cc-tool", role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "bash",
                callID: "cc-call",
                state: { status: "completed", output: "spent result" },
            },
        ],
    },
    ...Array.from({ length: 24 }, (_, index) => ({
        info: { id: `cc-filler-${index}`, role: index % 2 ? "assistant" : "user" },
        parts: [{ type: "text", text: `unchanged ${index}` }],
    })),
    {
        info: {
            id: "cc-thinking",
            role: "assistant",
            finish: "stop",
            time: { created: 1, completed: 2 },
        },
        parts: [
            { type: "step-start", text: "" },
            { type: "reasoning", text: "signed reasoning only" },
            { type: "step-finish", text: "" },
        ],
    },
    {
        info: { id: "cc-notice", role: "user" },
        parts: [
            { type: "text", text: "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>" },
        ],
    },
];

const output = { messages: source as unknown[] };
await transform({}, output);
writeFileSync(config.out, JSON.stringify(output.messages));
// The durable LKG row is written from a setImmediate callback; let it run.
await Bun.sleep(150);
