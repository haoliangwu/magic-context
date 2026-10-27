/// <reference types="bun-types" />
// Independent randomized cache-safety driver for four signed-thinking
// safeguards of the prefix-bound thinking hold (GitHub issue 729): the thinking
// strip a compaction-off first render takes when it changes the head, the
// durable record of messages a last-good replay served untagged, the deferral
// of the system date on an idle-expired request that keeps signed thinking,
// and the refused-fit marker that applies only to held passes. OpenCode 1 and
// OpenCode 2, TypeScript mode. Skipped unless MC_REVIEW_729F=1.
//
// Compared with review-729-driver.test.ts it adds, per pass at random:
// switches between managed and compaction-off mode (each one a restart, as a
// configuration change is), project-docs and project-memory edits (so a first
// render really changes the head), forks through the production clone copier
// (whole-session and truncated, OpenCode 2 style id mapping), the system-prompt
// hook with day rollovers (before or after the messages pass), and, on HEAD
// only, a failed write of the durable untagged-message record.
//
// The same random stream runs in lockstep through this checkout (HEAD) and,
// when MC_REVIEW_729F_BASE names a checkout of the base revision, through that
// base as a separate module graph with its own database and data directory.
//
// Oracles, per side:
// - strict binding: every served signed block has in front of it the bytes,
//   and the system date, of the request whose response produced it (a gap-free
//   run of the oldest thinking blocks may be missing; nothing else may differ);
// - turn completeness: the open turn serves all of its signed blocks, none, or
//   all but a gap-free oldest run;
// - quiet-pass stability: a pass whose logs grant no prefix change serves the
//   same provider-visible view as the pass before it.
// HEAD and base are also compared pass by pass until they first diverge, and
// passes where HEAD drops signed blocks that base kept validly are counted.
import { expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { providerVisiblePart } from "./provider-visible-parts";

const ENABLED = process.env.MC_REVIEW_729F === "1";
const BASE_ROOT = process.env.MC_REVIEW_729F_BASE;
const HEAD_ROOT = resolve(import.meta.dir, "../../../../..");
const PASSES = Number(process.env.MC_REVIEW_729F_PASSES ?? 420);
const SEED = Number(process.env.MC_REVIEW_729F_SEED ?? 7291);
const HOSTS = (process.env.MC_REVIEW_729F_HOSTS ?? "opencode1,opencode2").split(",");
const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
type Db = {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
        run: (...a: unknown[]) => unknown;
        all: (...a: unknown[]) => unknown[];
    };
};

// Two module graphs (HEAD and base) of one shape, loaded dynamically.
type Mod = any;
type Graph = {
    name: string;
    root: string;
    transform: Mod;
    wrapper: Mod;
    storage: Mod;
    tagger: Mod;
    scheduler: Mod;
    pending: Mod;
    lkg: Mod;
    comp: Mod;
    meta: Mod;
    logger: Mod;
    systemHash: Mod;
    dateRefresh: Mod;
    memory: Mod;
    projectState: Mod;
    projectIdentity: Mod;
    clone: Mod;
    fork: Mod;
    lkgPrefix: Mod;
    persisted: Mod;
};

async function loadGraph(root: string, name: string): Promise<Graph> {
    const src = join(root, "packages/plugin/src");
    const paths = {
        transform: "hooks/magic-context/transform.ts",
        wrapper: "plugin/messages-transform.ts",
        storage: "features/magic-context/storage.ts",
        tagger: "features/magic-context/tagger.ts",
        scheduler: "features/magic-context/scheduler.ts",
        pending: "hooks/magic-context/pending-materialization.ts",
        lkg: "hooks/magic-context/lkg-slot.ts",
        comp: "features/magic-context/compartment-storage.ts",
        meta: "features/magic-context/storage-meta-shared.ts",
        logger: "shared/logger.ts",
        systemHash: "hooks/magic-context/system-prompt-hash.ts",
        dateRefresh: "hooks/magic-context/system-date-refresh.ts",
        memory: "features/magic-context/memory/storage-memory.ts",
        projectState: "features/magic-context/storage-project-state.ts",
        projectIdentity: "features/magic-context/memory/project-identity.ts",
        clone: "features/magic-context/storage-clone.ts",
        fork: "v2/fork-inheritance.ts",
        lkgPrefix: "hooks/magic-context/lkg-recovery-prefix.ts",
        persisted: "features/magic-context/storage-meta-persisted.ts",
    } as const;
    const entries = await Promise.all(
        Object.entries(paths).map(async ([key, path]) => [key, await import(join(src, path))]),
    );
    return { name, root, ...Object.fromEntries(entries) } as Graph;
}

function rng(seed: number) {
    // xorshift32; independent of any generator used elsewhere in the repo.
    let x = seed >>> 0 || 1;
    return () => {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x / 4294967296;
    };
}

const isSigned = (part: Part) =>
    part.type === "reasoning" &&
    typeof part.text === "string" &&
    part.text !== "" &&
    (part.metadata as { anthropic?: { signature?: unknown } } | undefined)?.anthropic?.signature !==
        undefined;
const sig = (part: Part) =>
    String((part.metadata as { anthropic: { signature: unknown } }).anthropic.signature);

type View = { role: unknown; parts: string[] };
function view(message: Message): View {
    return {
        role: message.info.role,
        parts: message.parts
            .filter((p) => !((p.type === "text" || p.type === "reasoning") && p.text === ""))
            .filter((p) => p.ignored !== true)
            .map((p) =>
                isSigned(p)
                    ? `THINK:${sig(p)}:${String(p.text)}`
                    : JSON.stringify(providerVisiblePart(p as never)),
            ),
    };
}
const sameView = (a: View | undefined, b: View | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);

function bindingProblem(birth: View[], now: View[]): string | null {
    if (birth.length !== now.length) return `prefix length ${birth.length} -> ${now.length}`;
    const born: string[] = [];
    const kept: string[] = [];
    for (let i = 0; i < birth.length; i++) {
        const a = birth[i]!;
        const b = now[i]!;
        if (a.role !== b.role) return `message ${i} role`;
        const ao = a.parts.filter((p) => !p.startsWith("THINK:"));
        const bo = b.parts.filter((p) => !p.startsWith("THINK:"));
        if (JSON.stringify(ao) !== JSON.stringify(bo)) {
            for (let k = 0; k < Math.max(ao.length, bo.length); k++)
                if (ao[k] !== bo[k]) {
                    const x = String(ao[k]);
                    const y = String(bo[k]);
                    let d = 0;
                    while (d < x.length && x[d] === y[d]) d++;
                    return `message ${i} part ${k} @${d}: ${x.slice(Math.max(0, d - 60), d + 60)} => ${y.slice(Math.max(0, d - 60), d + 60)}`;
                }
        }
        born.push(...a.parts.filter((p) => p.startsWith("THINK:")));
        kept.push(...b.parts.filter((p) => p.startsWith("THINK:")));
    }
    const offset = born.length - kept.length;
    if (offset < 0) return "prefix gained thinking";
    for (let i = 0; i < kept.length; i++)
        if (born[offset + i] !== kept[i]) return "thinking removed from the middle or edited";
    return null;
}

const PERMISSION_LOG =
    /WILL APPLY|executed=true|m1Refreshed=true|thinking strip|binding|lkg|first_render|recovery|fit|release|EMERGENCY|emergency|frozen|date|untagged/i;

const isQuiet = (lines: string[]) =>
    lines.some((l) => l.includes("pending ops WILL NOT APPLY")) &&
    !lines.some((l) =>
        /pending ops WILL APPLY|heuristics WILL RUN|executed=true|m1Refreshed=true|rematerialized=true|thinking strip|LKG replay|lkg_replay|released|REFUSED|first_render|mode transition|compaction mode/i.test(
            l,
        ),
    );

type Birth = { views: View[]; date: string | undefined };
type Side = {
    graph: Graph;
    home: string;
    db: Db;
    handler: (i: unknown, o: unknown) => Promise<unknown>;
    systemHandler: (i: unknown, o: unknown) => Promise<unknown>;
    rebuild: () => void;
    history: Set<string>;
    systemRefresh: Set<string>;
    pending: Set<string>;
    usage: Map<string, unknown>;
    births: Map<string, Birth>;
    previous: View[] | null;
    lastServed: Message[] | null;
    servedDate: string | undefined;
    lines: string[];
    failNext: boolean;
    failRecordWrite: boolean;
    counts: Record<string, number>;
    problems: string[];
};

function isRealUser(message: Message): boolean {
    return message.info.role === "user" && !message.parts.every((p) => p.synthetic === true);
}

function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export async function runDriver(host: "opencode1" | "opencode2") {
    const random = rng(SEED + (host === "opencode2" ? 17 : 0));
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const tmpRoot = join(process.env.TMPDIR ?? tmpdir(), "magic-context", "729f-review");
    mkdirSync(tmpRoot, { recursive: true });
    const root = createTestTempDirFromPath(join(tmpRoot, `oc-${host}-${SEED}-`));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "ARCHITECTURE.md"), "# Architecture\n\nv0\n");
    let sessionId = `r729f-${host}`;
    let compactionOff = random() < 0.4;
    let percent = 30;
    let today = "2026-10-21";
    const usageEntry = () => ({
        usage: { percentage: percent, inputTokens: Math.round(percent * 1000) },
        updatedAt: Date.now(),
        hasUsageTokens: true,
    });
    const liveModels = new Map<string, typeof MODEL>([[sessionId, MODEL]]);
    const directories = new Map<string, string>([[sessionId, project]]);
    const graphs: Graph[] = [await loadGraph(HEAD_ROOT, "head")];
    if (BASE_ROOT) graphs.push(await loadGraph(BASE_ROOT, "base"));
    const useHome = (side: Side) => {
        process.env.XDG_DATA_HOME = side.home;
    };
    const sides: Side[] = graphs.map((graph) => {
        const home = join(root, `${graph.name}-home`);
        mkdirSync(home, { recursive: true });
        process.env.XDG_DATA_HOME = home;
        const db = graph.storage.openDatabase() as Db;
        const side = {
            graph,
            home,
            db,
            history: new Set<string>(),
            systemRefresh: new Set<string>(),
            pending: new Set<string>(),
            usage: new Map<string, unknown>([[sessionId, usageEntry()]]),
            births: new Map(),
            previous: null,
            lastServed: null,
            servedDate: undefined,
            lines: [],
            failNext: false,
            failRecordWrite: false,
            counts: {
                passes: 0,
                servedPasses: 0,
                refusals: 0,
                lkgReplays: 0,
                strictChecks: 0,
                strictBroken: 0,
                strictBrokenOpenTurn: 0,
                dateBroken: 0,
                partialTurn: 0,
                quietPasses: 0,
                prefixChanged: 0,
                prefixChangedUnexplained: 0,
                offPasses: 0,
                offFirstRenderStrips: 0,
                recordWriteFailures: 0,
                forks: 0,
                switches: 0,
                strippedWhereBaseKeptValidly: 0,
                brokenPasses: 0,
                headOnlyBrokenPasses: 0,
            },
            problems: [],
        } as unknown as Side;
        graph.dateRefresh.registerSystemDateRefresh(side.history);
        side.rebuild = () => {
            const transform = graph.transform.createTransform({
                db,
                tagger: graph.tagger.createTagger(),
                scheduler: graph.scheduler.createScheduler({ executeThresholdPercentage: 65 }),
                contextUsageMap: side.usage,
                historyRefreshSessions: side.history,
                pendingMaterializationSessions: side.pending,
                lastHeuristicsTurnId: new Map(),
                liveModelBySession: liveModels,
                protectedTokens: 1500,
                protectedTools: { bash: 0 },
                historianRunnable: false,
                directory: project,
                sessionDirectoryBySession: directories,
                injectDocs: true,
                memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true },
                ...(compactionOff ? { compactionOff: true } : {}),
                ...(host === "opencode2"
                    ? {
                          storeGeneration: "v2",
                          hostCleanupCompactionMarkers: () => ({
                              verified: true,
                              removedLineages: 0,
                              removedRows: 0,
                              retainedLineages: 0,
                          }),
                      }
                    : {}),
            });
            const inner = async (input: unknown, output: unknown) => {
                if (side.failNext) {
                    side.failNext = false;
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                await transform(input, output);
            };
            side.handler = graph.wrapper.createMessagesTransformHandler({
                magicContext: { "experimental.chat.messages.transform": inner },
            });
            side.systemHandler = graph.systemHash.createSystemPromptHashHandler({
                db,
                dreamerEnabled: false,
                resolveModel: () => MODEL,
                historyRefreshSessions: side.history,
                systemPromptRefreshSessions: side.systemRefresh,
                pendingMaterializationSessions: side.pending,
                lastHeuristicsTurnId: new Map(),
            }).handler;
        };
        side.rebuild();
        graph.storage.getOrCreateSessionMeta(db, sessionId);
        graph.storage.updateSessionMeta(db, sessionId, {
            cacheTtl: "59m",
            lastResponseTime: Date.now(),
        });
        spyOn(graph.logger, "sessionLog").mockImplementation((...args: unknown[]) => {
            side.lines.push(args.slice(1).map(String).join(" "));
        });
        // HEAD only: a failed write of the durable untagged-message record.
        if (typeof graph.lkgPrefix.persistLkgUntaggedInputIds === "function") {
            const original = graph.lkgPrefix.persistLkgUntaggedInputIds;
            spyOn(graph.lkgPrefix, "persistLkgUntaggedInputIds").mockImplementation(
                (...args: unknown[]) => {
                    if (side.failRecordWrite) {
                        side.counts.recordWriteFailures++;
                        side.lines.push("INJECTED untagged record write failure");
                        return false;
                    }
                    return original(...args);
                },
            );
        }
        return side;
    });

    let source: Message[] = [];
    let clock = 1;
    let call = 0;
    let forkCount = 0;
    const compartments: Array<{ end: number; sequence: number }> = [];
    let compartmentEnd = -1;
    let compartmentSequence = 0;
    let bigToolCall: string | null = null;
    const divergence: string[] = [];
    const headOnly: string[] = [];
    let diverged = false;
    let lastRefused = false;
    const user = (synthetic = false) =>
        source.push({
            info: {
                id: `${synthetic ? "cont" : "user"}-${clock}`,
                role: "user",
                sessionID: sessionId,
                time: { created: clock++ },
            },
            parts: [
                synthetic
                    ? { type: "text", text: "Continue with the todo list.", synthetic: true }
                    : { type: "text", text: `task ${clock}` },
            ],
        });
    const step = (kind: "heavy-recorded" | "heavy-text" | "light" | "big" | "final") => {
        const id = ++call;
        const heavyText = kind === "heavy-text";
        const parts: Part[] = [
            {
                type: "reasoning",
                text: heavyText
                    ? `t${id} ${"consider each branch of the plan ".repeat(260)}`
                    : `t${id} plan`,
                metadata: { anthropic: { signature: `s${id}` } },
            },
        ];
        if (kind === "final") parts.push({ type: "text", text: `done ${id}` });
        else {
            const output =
                kind === "big"
                    ? `big ${id} ${"FILLER ".repeat(70_000)}`
                    : `${id} ${"x = f(y); // line\n".repeat(12)}`;
            if (kind === "big") bigToolCall = `c${id}`;
            parts.push({
                type: "tool",
                callID: `c${id}`,
                tool: "bash",
                state: { status: "completed", input: { command: `step ${id}` }, output },
            });
        }
        source.push({
            info: {
                id: `a${id}`,
                role: "assistant",
                sessionID: sessionId,
                time: { created: clock++ },
                finish: kind === "final" ? "stop" : "tool-calls",
                ...MODEL,
                tokens: {
                    input: 0,
                    output: 100,
                    reasoning: kind === "heavy-recorded" ? 1_501 + Math.floor(random() * 3000) : 0,
                },
            },
            parts,
        });
        return `s${id}`;
    };

    /**
     * Fork the session (OpenCode 2 style: the fork's rows get new ids, tool
     * call ids are kept) through the production clone copier, optionally
     * truncated at a real user message, and continue on the fork.
     */
    const fork = (truncate: boolean) => {
        let keep = source.length;
        if (truncate) {
            const cuts: number[] = [];
            for (let i = 1; i < source.length; i++) if (isRealUser(source[i]!)) cuts.push(i);
            if (cuts.length > 0) keep = cuts[Math.floor(random() * cuts.length)]!;
        }
        forkCount++;
        const parentId = sessionId;
        const childId = `${sessionId.split("~")[0]}~f${forkCount}`;
        const kept = source.slice(0, keep);
        const idMap = new Map<string, string>();
        const forkOrdinals = new Map<string, number>();
        const parentOrdinals = new Map<number, string>();
        kept.forEach((message, index) => {
            const parentMessageId = String(message.info.id);
            const forkMessageId = `fk${forkCount}_${parentMessageId.replace(/^fk\d+_/, "")}`;
            idMap.set(parentMessageId, forkMessageId);
            forkOrdinals.set(forkMessageId, index + 1);
            parentOrdinals.set(index + 1, parentMessageId);
        });
        for (const side of sides) {
            useHome(side);
            const g = side.graph;
            const toolTags = side.db
                .prepare(
                    "SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool'",
                )
                .all(parentId) as Array<{
                message_id: string;
                tool_owner_message_id: string | null;
            }>;
            const copiedToolCallIds = new Set(
                toolTags
                    .filter((r) => r.tool_owner_message_id && idMap.has(r.tool_owner_message_id))
                    .map((r) => r.message_id),
            );
            g.clone.copySessionStateForClone(
                side.db,
                parentId,
                childId,
                g.fork.forkCloneFilter(
                    { parentToFork: idMap, forkOrdinals, parentOrdinals, throughSeq: keep },
                    copiedToolCallIds,
                ),
            );
            g.storage.getOrCreateSessionMeta(side.db, childId);
            g.storage.updateSessionMeta(side.db, childId, {
                cacheTtl: "59m",
                lastResponseTime: Date.now(),
            });
            side.usage.set(childId, usageEntry());
            side.counts.forks++;
        }
        liveModels.set(childId, MODEL);
        directories.set(childId, project);
        source = kept.map((message) => ({
            ...message,
            info: {
                ...message.info,
                id: idMap.get(String(message.info.id)),
                sessionID: childId,
            },
        }));
        sessionId = childId;
        // History blocks whose end was copied keep their sequence numbers.
        while (compartments.length > 0 && compartments[compartments.length - 1]!.end >= keep)
            compartments.pop();
        compartmentEnd = compartments.length > 0 ? compartments[compartments.length - 1]!.end : -1;
        compartmentSequence = compartments.length;
        if (bigToolCall && !source.some((m) => m.parts.some((p) => p.callID === bigToolCall)))
            bigToolCall = null;
        if (truncate) user();
    };

    try {
        user();
        for (let pass = 0; pass < PASSES; pass++) {
            const events: string[] = [];
            let systemFirst = false;
            if (pass > 0) {
                const r = random();
                if (r < 0.06) {
                    user();
                    events.push("user");
                } else if (r < 0.14) {
                    user(true);
                    events.push("continuation");
                }
                if (lastRefused) {
                    percent = 96;
                    events.push("usage=96", "drop");
                } else if (random() < 0.25) {
                    percent = pick([
                        10, 30, 50, 60, 64, 66, 70, 74, 75, 76, 80, 84, 85, 86, 90, 95, 96,
                    ]);
                    events.push(`usage=${percent}`);
                }
                const d = Array.from({ length: 16 }, () => random());
                if (d[0]! < 0.2 && !events.includes("drop")) events.push("drop");
                if (d[1]! < 0.06) events.push("flush");
                if (d[2]! < 0.06) events.push("compartment");
                if (d[3]! < 0.04) events.push("idle");
                if (d[4]! < 0.04) events.push("first-render");
                if (d[5]! < 0.04) events.push("restart");
                if (d[6]! < 0.05) events.push("lkg-fail");
                if (d[7]! < 0.04) events.push("switch");
                if (d[8]! < 0.05) events.push("docs");
                if (d[9]! < 0.04) events.push("memory");
                if (d[10]! < 0.05) events.push("rollover");
                if (d[11]! < 0.02) events.push(d[12]! < 0.5 ? "fork" : "fork-truncated");
                if (d[13]! < 0.04) events.push("record-fail");
                systemFirst = d[14]! < 0.35;
                const dropPick = d[15]!;
                if (events.includes("fork")) fork(false);
                if (events.includes("fork-truncated")) fork(true);
                if (events.includes("switch")) compactionOff = !compactionOff;
                if (events.includes("rollover")) today = addDays(today, 1);
                if (events.includes("docs"))
                    writeFileSync(
                        join(project, "ARCHITECTURE.md"),
                        `# Architecture\n\nrevision ${pass}\n`,
                    );
                let compartment: unknown = null;
                if (events.includes("compartment")) {
                    const ends: number[] = [];
                    const midTurn = random() < 0.5;
                    for (let i = compartmentEnd + 2; i < source.length - 4; i++) {
                        const next = source[i + 1]!;
                        if (
                            midTurn
                                ? next.info.role === "user" || next.info.role === "assistant"
                                : isRealUser(next)
                        )
                            ends.push(i);
                    }
                    if (ends.length > 0) {
                        const end = ends[Math.floor(random() * ends.length)]!;
                        compartment = {
                            sequence: compartmentSequence++,
                            startMessage: compartmentEnd + 2,
                            endMessage: end + 1,
                            startMessageId: String(source[compartmentEnd + 1]!.info.id),
                            endMessageId: String(source[end]!.info.id),
                            title: `history ${pass}`,
                            content: `U: summarized up to pass ${pass}`,
                        };
                        compartments.push({ end, sequence: compartmentSequence - 1 });
                        compartmentEnd = end;
                    }
                }
                for (const side of sides) {
                    useHome(side);
                    const g = side.graph;
                    if (events.includes("drop")) {
                        const tags = (
                            g.storage.getTagsBySession(side.db, sessionId) as Array<{
                                type: string;
                                status: string;
                                tagNumber: number;
                                messageId?: string;
                            }>
                        ).filter((t) => t.type === "tool" && t.status === "active");
                        const big = bigToolCall
                            ? tags.find((t) => t.messageId?.includes(String(bigToolCall)))
                            : undefined;
                        const target = big ?? tags[Math.floor(dropPick * tags.length)];
                        if (target)
                            g.storage.queuePendingOp(side.db, sessionId, target.tagNumber, "drop");
                    }
                    if (events.includes("flush"))
                        g.pending.requestPendingMaterialization(
                            side.pending,
                            sessionId,
                            "user_flush",
                        );
                    if (compartment) {
                        g.comp.appendCompartments(side.db, sessionId, [compartment]);
                        side.history.add(sessionId);
                    }
                    if (events.includes("memory")) {
                        const identity = g.projectIdentity.resolveProjectIdentity(project);
                        g.memory.insertMemory(side.db, {
                            projectPath: identity,
                            category: "USER_DIRECTIVES",
                            content: `Directive from pass ${pass}`,
                        });
                        g.projectState.bumpProjectMemoryEpoch(side.db, identity);
                    }
                    if (events.includes("idle")) {
                        side.db
                            .prepare(
                                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
                            )
                            .run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
                        g.storage.updateSessionMeta(side.db, sessionId, {
                            lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
                        });
                    }
                    if (events.includes("first-render")) g.meta.clearCachedM0M1(side.db, sessionId);
                    if (events.includes("restart") || events.includes("switch")) {
                        g.lkg.resetLkgSlotsForTest();
                        side.rebuild();
                    }
                    if (events.includes("switch")) side.counts.switches++;
                    if (events.includes("lkg-fail")) side.failNext = true;
                    side.failRecordWrite = events.includes("record-fail");
                }
            }
            for (const side of sides) side.usage.set(sessionId, usageEntry());
            const served: Array<Message[] | null> = [];
            const dates: Array<string | undefined> = [];
            for (const side of sides) {
                useHome(side);
                side.lines.length = 0;
                const messages = structuredClone(source);
                const output = { messages };
                const identity = {};
                side.graph.dateRefresh.bindSystemDateRequestIdentity(output, identity);
                const system = {
                    system: [`Base instructions\n<plugin-env>\n  Date: ${today}\n</plugin-env>`],
                };
                const runSystem = () =>
                    side.systemHandler(
                        { sessionID: sessionId, dateRefreshRequest: identity },
                        system,
                    );
                side.counts.passes++;
                if (compactionOff) side.counts.offPasses++;
                let systemPromise: Promise<unknown> | null = null;
                // System first: the hook may wait for the messages pass to decide.
                if (systemFirst) systemPromise = runSystem();
                try {
                    await side.handler({}, output);
                    if (systemPromise) await systemPromise;
                    else await runSystem();
                    served.push(messages);
                    dates.push(/Date: (\S+)/.exec(system.system.join("\n"))?.[1]);
                } catch (error) {
                    if (systemPromise) await systemPromise.catch(() => undefined);
                    side.counts.refusals++;
                    side.lines.push(
                        `REFUSED ${(error as Error).name}: ${(error as Error).message}`,
                    );
                    served.push(null);
                    dates.push(undefined);
                }
                side.failRecordWrite = false;
                await new Promise((r) => setImmediate(r));
            }
            if ((process.env.MC_REVIEW_729F_DUMP ?? "").split(",").includes(String(pass)))
                for (const side of sides)
                    console.log(
                        `DUMP ${side.graph.name} pass ${pass} [${events}] off=${compactionOff}\n${side.lines.filter((l) => !l.startsWith("transform stage:")).join("\n")}\nSERVED ${JSON.stringify(
                            (served[sides.indexOf(side)] ?? []).map(
                                (m) =>
                                    `${String(m.info.id)}:${m.parts
                                        .map((p) =>
                                            p.type === "reasoning"
                                                ? `R(${isSigned(p) ? sig(p) : "-"})`
                                                : p.type === "tool"
                                                  ? `T(${String((p.state as { output?: string }).output).slice(0, 7)})`
                                                  : `${String(p.type)}(${String(p.text ?? "").slice(0, 12)})`,
                                        )
                                        .join("+")}`,
                            ),
                        )}`,
                    );
            const signedServed = served.map(
                (out) => new Set((out ?? []).flatMap((m) => m.parts.filter(isSigned).map(sig))),
            );
            const brokenThisPass: boolean[] = [];
            sides.forEach((side, index) => {
                const out = served[index];
                const date = dates[index];
                brokenThisPass.push(false);
                if (side.lines.some((l) => /lkg_replay_served/i.test(l))) side.counts.lkgReplays++;
                if (
                    compactionOff &&
                    side.lines.some((l) => /proactive thinking strip/i.test(l)) &&
                    side.lines.some((l) => /first_render/i.test(l))
                )
                    side.counts.offFirstRenderStrips++;
                if (!out) return;
                side.counts.servedPasses++;
                const views = out.map(view);
                let openStart = source.length;
                for (let i = source.length - 1; i >= 0; i--)
                    if (isRealUser(source[i]!)) {
                        openStart = i + 1;
                        break;
                    }
                const openTurn = new Set(
                    source.slice(openStart).flatMap((m) => m.parts.filter(isSigned).map(sig)),
                );
                for (let i = 0; i < out.length; i++)
                    for (const part of out[i]!.parts) {
                        if (!isSigned(part)) continue;
                        const birth = side.births.get(sig(part));
                        if (!birth) continue;
                        side.counts.strictChecks++;
                        let problem = bindingProblem(birth.views, views.slice(0, i));
                        if (!problem && birth.date !== undefined && birth.date !== date) {
                            problem = `system date ${birth.date} -> ${date}`;
                            side.counts.dateBroken++;
                        }
                        if (problem) {
                            side.counts.strictBroken++;
                            if (openTurn.has(sig(part))) side.counts.strictBrokenOpenTurn++;
                            brokenThisPass[index] = true;
                            if (side.problems.length < 40)
                                side.problems.push(
                                    `pass ${pass} [${events.join(",")}] off=${compactionOff} usage=${percent} ${sig(part)}${openTurn.has(sig(part)) ? "(open)" : "(old)"}: ${problem} | ${side.lines
                                        .filter((l) => PERMISSION_LOG.test(l))
                                        .slice(0, 6)
                                        .join(" || ")
                                        .slice(0, 600)}`,
                                );
                        }
                    }
                let start = source.length;
                for (let i = source.length - 1; i >= 0; i--)
                    if (isRealUser(source[i]!)) {
                        start = i + 1;
                        break;
                    }
                const turnSigs = source
                    .slice(start)
                    .flatMap((m) => m.parts.filter(isSigned).map(sig));
                const servedSigs = signedServed[index]!;
                const keptInTurn = turnSigs.filter((s) => servedSigs.has(s));
                if (keptInTurn.length > 0 && keptInTurn.length !== turnSigs.length) {
                    const firstKept = turnSigs.indexOf(keptInTurn[0]!);
                    const gapFree = turnSigs.slice(firstKept).every((s) => servedSigs.has(s));
                    side.counts.partialTurn++;
                    if (!gapFree && side.problems.length < 40)
                        side.problems.push(
                            `pass ${pass}: open turn serves a middle gap ${JSON.stringify(turnSigs.map((s) => (servedSigs.has(s) ? s : "_")))}`,
                        );
                }
                if (side.previous && !events.some((e) => e.startsWith("fork"))) {
                    const changed = side.previous.some((v, i) => !sameView(v, views[i]));
                    const explained = !isQuiet(side.lines);
                    if (changed) side.counts.prefixChanged++;
                    if (changed && !explained) {
                        side.counts.prefixChangedUnexplained++;
                        if (side.problems.length < 40)
                            side.problems.push(
                                `pass ${pass} [${events.join(",")}] off=${compactionOff}: prefix changed with no permission log`,
                            );
                    }
                    if (!explained) side.counts.quietPasses++;
                }
                side.previous = views;
                side.lastServed = out;
                side.servedDate = date;
            });
            sides.forEach((side, index) => {
                if (brokenThisPass[index]) side.counts.brokenPasses++;
            });
            if (sides.length === 2 && brokenThisPass[0] && served[1] && !brokenThisPass[1]) {
                sides[0]!.counts.headOnlyBrokenPasses++;
                headOnly.push(`pass ${pass} [${events.join(",")}]`);
            }
            if (sides.length === 2 && served[0] && served[1] && !brokenThisPass[1]) {
                const headSigs = signedServed[0]!;
                const baseSigs = signedServed[1]!;
                if ([...baseSigs].some((s) => !headSigs.has(s))) {
                    sides[0]!.counts.strippedWhereBaseKeptValidly++;
                    if (sides[0]!.problems.length < 40 && !diverged)
                        sides[0]!.problems.push(
                            `INFO pass ${pass} [${events.join(",")}] off=${compactionOff}: head dropped ${[...baseSigs].filter((s) => !headSigs.has(s)).length} signed blocks base kept validly`,
                        );
                }
            }
            if (sides.length === 2 && !diverged) {
                const [h, b] = served;
                const same =
                    (h === null && b === null) ||
                    (h !== null &&
                        b !== null &&
                        dates[0] === dates[1] &&
                        JSON.stringify(h.map(view)) === JSON.stringify(b.map(view)));
                if (!same) {
                    diverged = true;
                    divergence.push(
                        `pass ${pass} [${events.join(",")}] off=${compactionOff} usage=${percent}: head ${h ? `served(${dates[0]})` : "refused"} / base ${b ? `served(${dates[1]})` : "refused"}; head logs: ${sides[0]!.lines
                            .filter((l) =>
                                /hold|frozen|WILL|strip|REFUSED|date|lkg|untagged/i.test(l),
                            )
                            .slice(0, 6)
                            .join(" || ")
                            .slice(0, 700)}; base logs: ${sides[1]!.lines
                            .filter((l) => /hold|frozen|WILL|strip|REFUSED|date|lkg/i.test(l))
                            .slice(0, 6)
                            .join(" || ")
                            .slice(0, 700)}`,
                    );
                }
            }
            lastRefused = served.some((s) => s === null);
            const anyServed = served.some((s) => s !== null);
            if (anyServed) {
                const draw = random();
                const kind =
                    bigToolCall === null && draw < 0.02
                        ? "big"
                        : draw < 0.1
                          ? "heavy-recorded"
                          : draw < 0.16
                            ? "heavy-text"
                            : draw < 0.22
                              ? "final"
                              : "light";
                const signature = step(kind);
                sides.forEach((side, index) => {
                    const out = served[index] ?? side.lastServed;
                    if (out)
                        side.births.set(signature, {
                            views: out.map(view),
                            date: served[index] ? dates[index] : side.servedDate,
                        });
                });
                for (const side of sides) {
                    useHome(side);
                    side.graph.storage.updateSessionMeta(side.db, sessionId, {
                        lastResponseTime: Date.now(),
                    });
                }
                if (kind === "final" && random() < 0.6) user();
            }
        }
        return {
            head: sides[0]!.counts,
            base: sides[1]?.counts,
            headProblems: sides[0]!.problems,
            baseProblems: sides[1]?.problems ?? [],
            divergence,
            headOnly,
        };
    } finally {
        for (const side of sides) {
            useHome(side);
            side.graph.lkg.resetLkgSlotsForTest();
            await side.graph.storage.closeDatabase();
        }
        cleanupTestTempDir(root);
        rmSync(root, { recursive: true, force: true });
    }
}

for (const host of HOSTS as Array<"opencode1" | "opencode2">)
    it.skipIf(!ENABLED)(
        `${host}: randomized follow-up driver (${PASSES} passes, modes, forks, dates)`,
        async () => {
            const result = await runDriver(host);
            const clip = (lines: string[], n: number, width: number) =>
                lines.slice(0, n).map((line) => line.slice(0, width));
            console.log(
                `[r729f-driver] ${host} seed=${SEED}\n head=${JSON.stringify(result.head)}\n base=${JSON.stringify(result.base)}\n headProblems(${result.headProblems.length})=${JSON.stringify(clip(result.headProblems, 12, 420), null, 1)}\n baseProblems(${result.baseProblems.length})=${JSON.stringify(clip(result.baseProblems, 2, 300))}\n divergence=${JSON.stringify(clip(result.divergence, 1, 900))}\n headOnly=${JSON.stringify(result.headOnly.slice(0, 20))}`,
            );
            expect(result.head.passes).toBe(PASSES);
            // Fails only on a pass where HEAD served an invalid signed block and base,
            // on the same event stream, did not. Breaks both sides share are
            // gaps that predate HEAD; they are counted and printed, not asserted.
            expect(result.headOnly).toEqual([]);
        },
        1_800_000,
    );
