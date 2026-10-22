/// <reference types="bun-types" />
// Independent randomized cache-safety driver for the bounded signed-thinking
// hold (issue 729), OpenCode 1 and OpenCode 2 in TypeScript mode. Skipped
// unless MC_REVIEW_729=1.
//
// The same random event stream runs, in lockstep, through this checkout (HEAD)
// and, when MC_REVIEW_729_BASE names a checkout of the base revision, through
// that base as a separate module graph with its own database. Each side goes
// through the real messages-transform wrapper, so a pass the transform cannot
// serve replays the last good request (LKG) exactly as in production.
//
// Oracles, per side:
// - strict binding: every served signed block has, in front of it, the bytes
//   of the request whose response produced it (a gap-free run of the oldest
//   thinking blocks may be missing; nothing else may differ);
// - turn completeness: the open turn serves all of its signed blocks, none,
//   or all but a gap-free oldest run;
// - quiet-pass stability: a pass whose logs show no permission to change the
//   prefix has the same provider-visible view as on the preceding pass;
// - refusals are counted per side, and the served/refused outcome and the
//   served view are compared between HEAD and base until they first diverge.
import { expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { providerVisiblePart } from "./provider-visible-parts";

const ENABLED = process.env.MC_REVIEW_729 === "1";
const BASE_ROOT = process.env.MC_REVIEW_729_BASE;
const HEAD_ROOT = resolve(import.meta.dir, "../../../../..");
const PASSES = Number(process.env.MC_REVIEW_729_PASSES ?? 420);
const SEED = Number(process.env.MC_REVIEW_729_SEED ?? 4729);
const MODEL_ID = process.env.MC_REVIEW_729_MODEL ?? "claude-opus-5-5";
const MODEL = { providerID: "anthropic", modelID: MODEL_ID };

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };

type Graph = {
    name: string;
    createTransform: (deps: unknown) => (input: unknown, output: unknown) => Promise<void>;
    createMessagesTransformHandler: (args: unknown) => (i: unknown, o: unknown) => Promise<unknown>;
    openDatabase: (path?: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
    };
    closeDatabase: () => Promise<void> | void;
    createTagger: () => unknown;
    createScheduler: (o: unknown) => unknown;
    requestPendingMaterialization: (s: Set<string>, id: string, origin: string) => void;
    resetLkgSlotsForTest: () => void;
    getOrCreateSessionMeta: (db: unknown, id: string) => Record<string, unknown>;
    updateSessionMeta: (db: unknown, id: string, patch: Record<string, unknown>) => void;
    queuePendingOp: (db: unknown, id: string, tag: number, op: string) => void;
    getTagsBySession: (
        db: unknown,
        id: string,
    ) => Array<{ type: string; status: string; tagNumber: number; messageId?: string }>;
    appendCompartments: (db: unknown, id: string, rows: unknown[]) => void;
    clearCachedM0M1: (db: unknown, id: string) => void;
    logger: { sessionLog: (...a: unknown[]) => void };
};

async function loadGraph(root: string, name: string): Promise<Graph> {
    const src = join(root, "packages/plugin/src");
    const m = await Promise.all([
        import(join(src, "hooks/magic-context/transform.ts")),
        import(join(src, "plugin/messages-transform.ts")),
        import(join(src, "features/magic-context/storage.ts")),
        import(join(src, "features/magic-context/tagger.ts")),
        import(join(src, "features/magic-context/scheduler.ts")),
        import(join(src, "hooks/magic-context/pending-materialization.ts")),
        import(join(src, "hooks/magic-context/lkg-slot.ts")),
        import(join(src, "features/magic-context/compartment-storage.ts")),
        import(join(src, "features/magic-context/storage-meta-shared.ts")),
        import(join(src, "shared/logger.ts")),
    ]);
    const [transform, wrapper, storage, tagger, scheduler, pending, lkg, comp, meta, logger] = m;
    return {
        name,
        createTransform: transform.createTransform,
        createMessagesTransformHandler: wrapper.createMessagesTransformHandler,
        openDatabase: storage.openDatabase,
        closeDatabase: storage.closeDatabase,
        createTagger: tagger.createTagger,
        createScheduler: scheduler.createScheduler,
        requestPendingMaterialization: pending.requestPendingMaterialization,
        resetLkgSlotsForTest: lkg.resetLkgSlotsForTest,
        getOrCreateSessionMeta: storage.getOrCreateSessionMeta,
        updateSessionMeta: storage.updateSessionMeta,
        queuePendingOp: storage.queuePendingOp,
        getTagsBySession: storage.getTagsBySession,
        appendCompartments: comp.appendCompartments,
        clearCachedM0M1: meta.clearCachedM0M1,
        logger,
    };
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
    /WILL APPLY|executed=true|m1Refreshed=true|proactive thinking strip|binding|lkg|first_render|recovery|fit|release|EMERGENCY|emergency/i;

/**
 * A pass is quiet when its drain was denied and nothing else announced a
 * prefix change: such a pass must have the same provider-visible view as
 * the preceding pass.
 */
const isQuiet = (lines: string[]) =>
    lines.some((l) => l.includes("pending ops WILL NOT APPLY")) &&
    !lines.some((l) =>
        /pending ops WILL APPLY|heuristics WILL RUN|executed=true|m1Refreshed=true|rematerialized=true|thinking strip|LKG replay|lkg_replay|released|REFUSED/.test(
            l,
        ),
    );

type Side = {
    graph: Graph;
    home: string;
    db: ReturnType<Graph["openDatabase"]>;
    handler: (i: unknown, o: unknown) => Promise<unknown>;
    rebuild: () => void;
    history: Set<string>;
    pending: Set<string>;
    usage: Map<string, unknown>;
    births: Map<string, View[]>;
    previous: View[] | null;
    lastServed: Message[] | null;
    lines: string[];
    failNext: boolean;
    counts: Record<string, number>;
    problems: string[];
};

function isRealUser(message: Message): boolean {
    return message.info.role === "user" && !message.parts.every((p) => p.synthetic === true);
}

export async function runOpenCodeDriver(host: "opencode1" | "opencode2"): Promise<{
    head: Side["counts"];
    base?: Side["counts"];
    headProblems: string[];
    baseProblems: string[];
    divergence: string[];
}> {
    const random = rng(SEED + (host === "opencode2" ? 17 : 0));
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const sessionId = `r729-${host}`;
    const root = createTestTempDir("mc-r729-drv-").dir;
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    let percent = 30;
    const inputPerPoint = 1000;
    const usageEntry = () => ({
        usage: { percentage: percent, inputTokens: Math.round(percent * inputPerPoint) },
        updatedAt: Date.now(),
        hasUsageTokens: true,
    });
    const graphs: Graph[] = [await loadGraph(HEAD_ROOT, "head")];
    if (BASE_ROOT) graphs.push(await loadGraph(BASE_ROOT, "base"));
    const useHome = (side: Side) => {
        process.env.XDG_DATA_HOME = side.home;
    };
    const sides: Side[] = graphs.map((graph) => {
        const home = join(root, `${graph.name}-home`);
        mkdirSync(home, { recursive: true });
        process.env.XDG_DATA_HOME = home;
        const db = graph.openDatabase()!;
        const side = {
            graph,
            home,
            db,
            history: new Set<string>(),
            pending: new Set<string>(),
            usage: new Map<string, unknown>([[sessionId, usageEntry()]]),
            births: new Map(),
            previous: null,
            lastServed: null,
            lines: [],
            failNext: false,
            counts: {
                passes: 0,
                servedPasses: 0,
                refusals: 0,
                lkgReplays: 0,
                strictChecks: 0,
                strictBroken: 0,
                partialTurn: 0,
                quietPasses: 0,
                quietChanged: 0,
                prefixChanged: 0,
                prefixChangedUnexplained: 0,
                heldLogged: 0,
            },
            problems: [],
        } as unknown as Side;
        side.rebuild = () => {
            const transform = graph.createTransform({
                db,
                tagger: graph.createTagger(),
                scheduler: graph.createScheduler({ executeThresholdPercentage: 65 }),
                contextUsageMap: side.usage,
                historyRefreshSessions: side.history,
                pendingMaterializationSessions: side.pending,
                lastHeuristicsTurnId: new Map(),
                liveModelBySession: new Map([[sessionId, MODEL]]),
                protectedTokens: 1500,
                protectedTools: { bash: 0 },
                historianRunnable: false,
                directory: project,
                sessionDirectoryBySession: new Map([[sessionId, project]]),
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
            side.handler = graph.createMessagesTransformHandler({
                magicContext: { "experimental.chat.messages.transform": inner },
            });
        };
        side.rebuild();
        graph.getOrCreateSessionMeta(db, sessionId);
        graph.updateSessionMeta(db, sessionId, { cacheTtl: "59m", lastResponseTime: Date.now() });
        spyOn(graph.logger, "sessionLog").mockImplementation((...args: unknown[]) => {
            side.lines.push(args.slice(1).map(String).join(" "));
        });
        return side;
    });

    const source: Message[] = [];
    let clock = 1;
    let call = 0;
    let compartmentEnd = -1;
    let compartmentSequence = 0;
    let bigToolCall: string | null = null;
    const divergence: string[] = [];
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

    try {
        user();
        for (let pass = 0; pass < PASSES; pass++) {
            const events: string[] = [];
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
                    // After a refusal, force the next pass into the 96% band and
                    // queue a drop (of the oversized result when it is found).
                    percent = 96;
                    events.push("usage=96", "drop");
                } else if (random() < 0.25) {
                    percent = pick([
                        10, 30, 50, 60, 64, 66, 70, 74, 75, 76, 80, 84, 85, 86, 90, 95, 96,
                    ]);
                    events.push(`usage=${percent}`);
                }
                const dropDraw = random();
                const flushDraw = random();
                const compDraw = random();
                const idleDraw = random();
                const firstRenderDraw = random();
                const restartDraw = random();
                const lkgDraw = random();
                const dropPick = random();
                if (dropDraw < 0.22 && !events.includes("drop")) events.push("drop");
                if (flushDraw < 0.06) events.push("flush");
                if (compDraw < 0.06) events.push("compartment");
                if (idleDraw < 0.03) events.push("idle");
                if (firstRenderDraw < 0.025) events.push("first-render");
                if (restartDraw < 0.03) events.push("restart");
                if (lkgDraw < 0.04) events.push("lkg-fail");
                const toolTags = (side: Side) =>
                    side.graph
                        .getTagsBySession(side.db, sessionId)
                        .filter((t) => t.type === "tool" && t.status === "active");
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
                        compartmentEnd = end;
                    }
                }
                for (const side of sides) {
                    useHome(side);
                    const g = side.graph;
                    if (events.includes("drop")) {
                        const tags = toolTags(side);
                        const big = bigToolCall
                            ? tags.find((t) => t.messageId?.includes(String(bigToolCall)))
                            : undefined;
                        const target = big ?? tags[Math.floor(dropPick * tags.length)];
                        if (target) g.queuePendingOp(side.db, sessionId, target.tagNumber, "drop");
                    }
                    if (events.includes("flush"))
                        g.requestPendingMaterialization(side.pending, sessionId, "user_flush");
                    if (compartment) {
                        g.appendCompartments(side.db, sessionId, [compartment]);
                        side.history.add(sessionId);
                    }
                    if (events.includes("idle")) {
                        side.db
                            .prepare(
                                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
                            )
                            .run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
                        g.updateSessionMeta(side.db, sessionId, {
                            lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
                        });
                    }
                    if (events.includes("first-render")) g.clearCachedM0M1(side.db, sessionId);
                    if (events.includes("restart")) {
                        g.resetLkgSlotsForTest();
                        side.rebuild();
                    }
                    if (events.includes("lkg-fail")) side.failNext = true;
                }
            }
            // Fit pressure: rarely a huge tool result arrives; the derived window
            // is inputTokens / percentage.
            for (const side of sides) side.usage.set(sessionId, usageEntry());
            const served: Array<Message[] | null> = [];
            for (const side of sides) {
                useHome(side);
                side.lines.length = 0;
                const messages = structuredClone(source);
                side.counts.passes++;
                try {
                    await side.handler({}, { messages });
                    served.push(messages);
                } catch (error) {
                    side.counts.refusals++;
                    side.lines.push(
                        `REFUSED ${(error as Error).name}: ${(error as Error).message}`,
                    );
                    served.push(null);
                }
                await new Promise((r) => setImmediate(r));
            }
            if ((process.env.MC_REVIEW_729_DUMP ?? "").split(",").includes(String(pass)))
                for (const side of sides)
                    console.log(
                        `DUMP ${side.graph.name} pass ${pass} [${events}]\n${side.lines.filter((l) => !l.startsWith("transform stage:")).join("\n")}\nSERVED-TAIL ${JSON.stringify(
                            (served[sides.indexOf(side)] ?? [])
                                .slice(-7)
                                .map(
                                    (m) =>
                                        `${String(m.info.id)}:${m.parts
                                            .map((p) =>
                                                p.type === "reasoning"
                                                    ? `R(${isSigned(p) ? sig(p) : "-"}${p.text === "" ? ",empty" : ""})`
                                                    : p.type === "tool"
                                                      ? `T(${String((p.state as { output?: string }).output).slice(0, 7)})`
                                                      : String(p.type),
                                            )
                                            .join("+")}`,
                                ),
                        )}`,
                    );
            sides.forEach((side, index) => {
                const out = served[index];
                if (
                    side.lines.some((l) =>
                        /signed thinking hold: held=true|frozen: active thinking turn/.test(l),
                    )
                )
                    side.counts.heldLogged++;
                if (side.lines.some((l) => /lkg.*replay|replayed last/i.test(l)))
                    side.counts.lkgReplays++;
                if (!out) return;
                side.counts.servedPasses++;
                const views = out.map(view);
                // Strict binding.
                for (let i = 0; i < out.length; i++)
                    for (const part of out[i]!.parts) {
                        if (!isSigned(part)) continue;
                        const birth = side.births.get(sig(part));
                        if (!birth) continue;
                        side.counts.strictChecks++;
                        const problem = bindingProblem(birth, views.slice(0, i));
                        if (problem) {
                            side.counts.strictBroken++;
                            if (side.problems.length < 40)
                                side.problems.push(
                                    `pass ${pass} [${events.join(",")}] usage=${percent} ${sig(part)}: ${problem} | ${side.lines
                                        .filter((l) => PERMISSION_LOG.test(l))
                                        .slice(0, 6)
                                        .join(" || ")
                                        .slice(0, 600)}`,
                                );
                        }
                    }
                // Turn completeness (open turn: after the last real user).
                let start = source.length;
                for (let i = source.length - 1; i >= 0; i--)
                    if (isRealUser(source[i]!)) {
                        start = i + 1;
                        break;
                    }
                const turnSigs = source
                    .slice(start)
                    .flatMap((m) => m.parts.filter(isSigned).map(sig));
                const servedSigs = new Set(out.flatMap((m) => m.parts.filter(isSigned).map(sig)));
                const keptInTurn = turnSigs.filter((s) => servedSigs.has(s));
                if (keptInTurn.length > 0 && keptInTurn.length !== turnSigs.length) {
                    // A gap-free oldest run missing is valid on the wire; anything else is not.
                    const firstKept = turnSigs.indexOf(keptInTurn[0]!);
                    const gapFree = turnSigs.slice(firstKept).every((s) => servedSigs.has(s));
                    side.counts.partialTurn++;
                    if (!gapFree && side.problems.length < 40)
                        side.problems.push(
                            `pass ${pass}: open turn serves a middle gap ${JSON.stringify(turnSigs.map((s) => (servedSigs.has(s) ? s : "_")))}`,
                        );
                }
                // Quiet-pass stability.
                if (side.previous) {
                    const changed = side.previous.some((v, i) => !sameView(v, views[i]));
                    const explained = !isQuiet(side.lines);
                    if (changed) side.counts.prefixChanged++;
                    if (changed && !explained) {
                        side.counts.prefixChangedUnexplained++;
                        if (side.problems.length < 40)
                            side.problems.push(
                                `pass ${pass} [${events.join(",")}]: prefix changed with no permission log`,
                            );
                    }
                    if (!explained) side.counts.quietPasses++;
                }
                side.previous = views;
                side.lastServed = out;
            });
            // Head vs base while both are in the same state.
            if (sides.length === 2 && !diverged) {
                const [h, b] = served;
                const same =
                    (h === null && b === null) ||
                    (h !== null &&
                        b !== null &&
                        JSON.stringify(h.map(view)) === JSON.stringify(b.map(view)));
                if (!same) {
                    diverged = true;
                    divergence.push(
                        `pass ${pass} [${events.join(",")}] usage=${percent}: head ${h ? "served" : "refused"} / base ${b ? "served" : "refused"}; head logs: ${sides[0]!.lines
                            .filter((l) => /hold|frozen|WILL|strip|REFUSED/.test(l))
                            .slice(0, 5)
                            .join(" || ")
                            .slice(0, 500)}; base logs: ${sides[1]!.lines
                            .filter((l) => /hold|frozen|WILL|strip|REFUSED/.test(l))
                            .slice(0, 5)
                            .join(" || ")
                            .slice(0, 500)}`,
                    );
                }
            }
            lastRefused = served.some((s) => s === null);
            // Append one simulated response to the shared source and record
            // each side's served view as the request that produced it.
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
                    if (out) side.births.set(signature, out.map(view));
                });
                for (const side of sides) {
                    useHome(side);
                    side.graph.updateSessionMeta(side.db, sessionId, {
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
        };
    } finally {
        for (const side of sides) {
            useHome(side);
            side.graph.resetLkgSlotsForTest();
            await side.graph.closeDatabase();
        }
        cleanupTestTempDir(root);
        rmSync(root, { recursive: true, force: true });
    }
}

for (const host of ["opencode1", "opencode2"] as const)
    it.skipIf(!ENABLED)(
        `${host}: randomized strict-binding driver (${PASSES} passes)`,
        async () => {
            const result = await runOpenCodeDriver(host);
            console.log(
                `[r729-driver] ${host} ${MODEL_ID} seed=${SEED} ${JSON.stringify(result, null, 1)}`,
            );
            expect(result.head.passes).toBe(PASSES);
            expect(result.headProblems).toEqual([]);
        },
        1_800_000,
    );
