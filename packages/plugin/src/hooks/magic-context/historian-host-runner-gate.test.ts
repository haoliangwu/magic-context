import { describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
} from "./compartment-runner-types";
import {
    type HistorianHostMethod,
    HistorianHostRunner,
    type HistorianHostRunnerDeps,
} from "./historian-host-runner";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

/**
 * Adversarial gate over the host pull loop.
 *
 * The lane below is the module's rules re-implemented, not a recording: the
 * module mints the attempt and the token, a live lease refuses a second
 * claimant, a lapsed one admits the next, a token that is no longer current is
 * refused wherever it is presented, exactly one report per run is taken, and
 * every op is answered only for the project the caller is bound to. A replay stub
 * would pass while the loop mishandled every rule these tests are named for.
 */

interface LaneRun {
    project: string;
    sessionId: string;
    system: string;
    user: string;
    modelChain: string[];
    awaitBudgetMs: number;
    deadlineMs: number;
    attempt: number;
    token: string | null;
    claimDeadlineMs: number;
    reported: boolean;
}

/** What a host sent, and which project its route was bound to. */
interface LaneCall {
    project: string;
    method: HistorianHostMethod;
    body: Record<string, unknown>;
}

class ProjectScopedClaimLane {
    readonly calls: LaneCall[] = [];
    readonly reports: Array<{ project: string; runId: string; body: Record<string, unknown> }> = [];
    private readonly runs = new Map<string, LaneRun>();
    now = 1_000;
    leaseMs = 600_000;

    queue(args: {
        runId: string;
        sessionId: string;
        project: string;
        user?: string;
        awaitBudgetMs?: number;
    }): void {
        const awaitBudgetMs = args.awaitBudgetMs ?? 660_000;
        this.runs.set(args.runId, {
            project: args.project,
            sessionId: args.sessionId,
            system: "system prompt",
            user: args.user ?? `transcript of ${args.sessionId}`,
            modelChain: ["prov/first"],
            awaitBudgetMs,
            deadlineMs: this.now + awaitBudgetMs,
            attempt: 0,
            token: null,
            claimDeadlineMs: 0,
            reported: false,
        });
    }

    phaseOf(runId: string): "pending" | "claimed" | "reported" | "gone" {
        const run = this.runs.get(runId);
        if (!run) return "gone";
        if (run.reported) return "reported";
        if (run.token !== null && run.claimDeadlineMs > this.now) return "claimed";
        return "pending";
    }

    /** A host bound to `project` speaking to the lane. */
    callerFor(project: string) {
        return async (args: {
            method: HistorianHostMethod;
            sessionId: string;
            body: Record<string, unknown>;
        }): Promise<unknown> => {
            this.calls.push({ project, method: args.method, body: args.body });
            const runId = String(args.body.run_id ?? "");
            const run = this.runs.get(runId);
            // A run in another project is answered exactly as one that does not
            // exist. A caller must not learn that another project on this machine
            // has a fold outstanding, let alone read its transcript.
            const mine = run && run.project === project ? run : undefined;
            switch (args.method) {
                case "historian.pending": {
                    const runs = [...this.runs.entries()]
                        .filter(
                            ([, entry]) =>
                                entry.project === project &&
                                !entry.reported &&
                                entry.deadlineMs > this.now &&
                                (entry.token === null || entry.claimDeadlineMs <= this.now),
                        )
                        .map(([id, entry]) => ({
                            run_id: id,
                            session_id: entry.sessionId,
                            chunk_fingerprint: `fp-${id}`,
                            prompt_bytes_len: entry.system.length + entry.user.length,
                            deadline_ms: entry.deadlineMs,
                        }));
                    return { ok: true, runs };
                }
                case "historian.claim": {
                    if (!mine) return { ok: false, refusal: "unknown_run" };
                    if (mine.reported || mine.deadlineMs <= this.now) {
                        return { ok: false, refusal: "not_pending" };
                    }
                    if (mine.token !== null && mine.claimDeadlineMs > this.now) {
                        return { ok: false, refusal: "already_claimed" };
                    }
                    mine.attempt += 1;
                    mine.token = `token-${runId}-${mine.attempt}`;
                    mine.claimDeadlineMs = Math.min(this.now + this.leaseMs, mine.deadlineMs);
                    return {
                        ok: true,
                        run_id: runId,
                        session_id: mine.sessionId,
                        attempt: mine.attempt,
                        token: mine.token,
                        prompt: { system: mine.system, user: mine.user },
                        model_chain: mine.modelChain,
                        await_budget_ms: mine.awaitBudgetMs,
                        claim_deadline_ms: mine.claimDeadlineMs,
                        heartbeat_interval_ms: 30_000,
                    };
                }
                case "historian.heartbeat": {
                    if (!mine) return { ok: false, refusal: "unknown_run" };
                    if (mine.token === null) return { ok: false, refusal: "not_claimed" };
                    if (mine.token !== args.body.token) {
                        return { ok: false, refusal: "superseded_token" };
                    }
                    if (mine.deadlineMs <= this.now) return { ok: false, refusal: "run_expired" };
                    mine.claimDeadlineMs = Math.min(this.now + this.leaseMs, mine.deadlineMs);
                    return {
                        ok: true,
                        claim_deadline_ms: mine.claimDeadlineMs,
                        heartbeat_interval_ms: 30_000,
                    };
                }
                case "historian.complete": {
                    if (!mine) return { ok: false, refusal: "unknown_run" };
                    if (mine.token !== args.body.token) {
                        return { ok: false, refusal: "superseded_token" };
                    }
                    if (mine.reported) return { ok: false, refusal: "already_reported" };
                    mine.reported = true;
                    this.reports.push({ project, runId, body: args.body });
                    return { ok: true, accepted: true, publish: "immediate" };
                }
            }
        };
    }

    /** Take the lease away from whoever holds it, as time passing would. */
    lapseLease(runId: string): void {
        const run = this.runs.get(runId);
        if (run) run.claimDeadlineMs = this.now - 1;
    }
}

interface ScriptedCompletion {
    started: Promise<void>;
    settle(completion: Partial<HiddenCompletion>): void;
    fail(error: Error): void;
}

/** A carrier whose completion the test finishes by hand. */
function scriptedExecutor(): { executor: HiddenCompletionExecutor; script: ScriptedCompletion } {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
    });
    let settleOutput!: (completion: HiddenCompletion) => void;
    let failOutput!: (error: Error) => void;
    const output = new Promise<HiddenCompletion>((resolve, reject) => {
        settleOutput = resolve;
        failOutput = reject;
    });
    output.catch(() => {});
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open: async (): Promise<HiddenRunHandle> => ({ id: "child", childSessionId: "child" }),
        attempt: async () => {
            announceStarted();
        },
        collect: () => output,
        close: async () => {},
    };
    return {
        executor,
        script: {
            started,
            settle: (completion) =>
                settleOutput({
                    text: completion.text ?? "<compartments/>",
                    usage: completion.usage ?? { input: 0, output: 0, reasoning: 0, cache: 0 },
                    lengthCapped: completion.lengthCapped ?? false,
                } as HiddenCompletion),
            fail: (error) => failOutput(error),
        },
    };
}

function hostOver(
    lane: ProjectScopedClaimLane,
    args: {
        project: string;
        claimantInstanceId: string;
        executors?: Map<string, HiddenCompletionExecutor>;
        enabled?: () => boolean;
    },
): { runner: HistorianHostRunner; logs: string[] } {
    const logs: string[] = [];
    const deps: HistorianHostRunnerDeps = {
        call: lane.callerFor(args.project),
        claimantInstanceId: args.claimantInstanceId,
        openExecutor: (sessionId) => {
            const executor = args.executors?.get(sessionId);
            return executor ? { executor, sessionDirectory: "/tmp/project" } : undefined;
        },
        enabled: args.enabled ?? (() => true),
        now: () => lane.now,
        log: (message) => logs.push(message),
        // Timers are never armed here: every test drives the loop explicitly.
        schedule: () => () => {},
    };
    return { runner: new HistorianHostRunner(deps), logs };
}

/** Let the loop's own promise chain settle without advancing any timer. */
async function settle(): Promise<void> {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

describe("host runner gate", () => {
    it("hands a killed host's run to the next one and refuses the dead host's late report", async () => {
        const lane = new ProjectScopedClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", project: "/projects/x" });
        const killed = scriptedExecutor();
        const survivor = scriptedExecutor();
        const hostA = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-a",
            executors: new Map([["ses-a", killed.executor]]),
        });
        const hostB = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-b",
            executors: new Map([["ses-a", survivor.executor]]),
        });

        await hostA.runner.pump("ses-a");
        await killed.script.started;
        expect(hostA.runner.inFlightSessions()).toEqual(["ses-a"]);
        const firstToken = String(
            lane.calls.find((call) => call.method === "historian.claim")?.body.run_id,
        );
        expect(firstToken).toBe("run-a");

        // Host B looks while host A still holds a live lease. A slow claimant looks
        // exactly like a dead one from here, so B must not take the run.
        await hostB.runner.pump("ses-a");
        await settle();
        expect(hostB.runner.inFlightSessions()).toEqual([]);
        expect(
            lane.calls.filter(
                (call) => call.method === "historian.claim" && call.body.run_id === "run-a",
            ),
        ).toHaveLength(1);

        // Host A is SIGKILLed mid-completion: its process is gone, so it never
        // reports and never beats again. The lease is what notices.
        lane.lapseLease("run-a");
        await hostB.runner.pump("ses-a");
        await survivor.script.started;
        survivor.script.settle({ text: "<compartments>b</compartments>" });
        await settle();

        expect(lane.reports).toHaveLength(1);
        expect(lane.reports[0]?.body.token).toBe("token-run-a-2");
        expect(lane.phaseOf("run-a")).toBe("reported");

        // The killed host's report, replayed by hand with the token it still held.
        const late = await lane.callerFor("/projects/x")({
            method: "historian.complete",
            sessionId: "ses-a",
            body: {
                v: 1,
                run_id: "run-a",
                token: "token-run-a-1",
                output: { text: "<compartments>a</compartments>", length_capped: false },
            },
        });
        expect(late).toEqual({ ok: false, refusal: "superseded_token" });
        expect(lane.reports).toHaveLength(1);
    });

    it("never lets a slow fold on one session delay a claim on another", async () => {
        const lane = new ProjectScopedClaimLane();
        lane.queue({ runId: "run-slow", sessionId: "ses-slow", project: "/projects/x" });
        lane.queue({ runId: "run-quick", sessionId: "ses-quick", project: "/projects/x" });
        lane.queue({ runId: "run-slow-2", sessionId: "ses-slow", project: "/projects/x" });
        const slow = scriptedExecutor();
        const quick = scriptedExecutor();
        const host = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-a",
            executors: new Map([
                ["ses-slow", slow.executor],
                ["ses-quick", quick.executor],
            ]),
        });

        // One pump. The slow session is first in the queue and never finishes during
        // it; if the loop awaited the fold, the quick session would not be claimed.
        await host.runner.pump("ses-slow");
        await slow.script.started;
        await quick.script.started;

        expect(host.runner.inFlightSessions().sort()).toEqual(["ses-quick", "ses-slow"]);
        // And the second run queued for the SAME session is left alone: the module
        // admits one firing per session, so a second claim buys a completion whose
        // report could never be published.
        expect(
            lane.calls.filter(
                (call) => call.method === "historian.claim" && call.body.run_id === "run-slow-2",
            ),
        ).toHaveLength(0);
        expect(lane.phaseOf("run-slow-2")).toBe("pending");

        quick.script.settle({});
        slow.script.settle({});
        await settle();
        expect(lane.reports.map((report) => report.runId).sort()).toEqual([
            "run-quick",
            "run-slow",
        ]);
    });

    it("claims nothing while the kill switch is off and says so once, and another host takes the run", async () => {
        const lane = new ProjectScopedClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", project: "/projects/x" });
        let enabled = false;
        const stopped = scriptedExecutor();
        const other = scriptedExecutor();
        const disabled = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-off",
            executors: new Map([["ses-a", stopped.executor]]),
            enabled: () => enabled,
        });
        const enabledHost = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-on",
            executors: new Map([["ses-a", other.executor]]),
        });

        await disabled.runner.pump("ses-a");
        await disabled.runner.pump("ses-a");
        await disabled.runner.pump("ses-a");
        await settle();

        expect(lane.calls.filter((call) => call.project === "/projects/x")).toEqual([]);
        expect(
            disabled.logs.filter((line) => line.includes("historian.host_runner.enabled=false")),
        ).toHaveLength(1);
        expect(lane.phaseOf("run-a")).toBe("pending");

        // The run is not lost, it is left: another host on the same project takes it.
        await enabledHost.runner.pump("ses-a");
        await other.script.started;
        other.script.settle({});
        await settle();
        expect(lane.reports.map((report) => report.runId)).toEqual(["run-a"]);

        // Turning it back on re-arms the log, so an operator toggling it twice sees
        // it twice rather than once.
        enabled = true;
        await disabled.runner.pump("ses-a");
        enabled = false;
        await disabled.runner.pump("ses-a");
        expect(
            disabled.logs.filter((line) => line.includes("historian.host_runner.enabled=false")),
        ).toHaveLength(2);
    });

    it("says once when the module refuses this host's poll outright, however the refusal arrives", async () => {
        // The module answers a lane op it will not serve - an unbound channel, an
        // unreadable version - with an error frame, not with `{ok: false, refusal}`.
        // That reaches the loop as a thrown error rather than as a body, and it is
        // the one fault worth saying exactly once: it does not clear on its own, so
        // a line per transform pass would be a line per pass forever.
        const refusedLane = {
            call: async () => {
                throw Object.assign(
                    new Error("historian.pending on a channel with no session binding"),
                    {
                        code: "route_unbound",
                    },
                );
            },
        };
        const logs: string[] = [];
        const runner = new HistorianHostRunner({
            call: refusedLane.call,
            claimantInstanceId: "install-host-a",
            openExecutor: () => undefined,
            enabled: () => true,
            log: (message) => logs.push(message),
            schedule: () => () => {},
        });

        await runner.pump("ses-a");
        await runner.pump("ses-a");
        await runner.pump("ses-a");

        const complaints = logs.filter((line) => line.includes("channel with no session binding"));
        expect(complaints).toHaveLength(1);
        expect(logs).toHaveLength(1);
    });

    it("never sees or claims a run belonging to another project", async () => {
        const lane = new ProjectScopedClaimLane();
        lane.queue({
            runId: "run-theirs",
            sessionId: "ses-theirs",
            project: "/projects/y",
            user: "a transcript this host must never read",
        });
        lane.queue({ runId: "run-mine", sessionId: "ses-mine", project: "/projects/x" });
        const mine = scriptedExecutor();
        const host = hostOver(lane, {
            project: "/projects/x",
            claimantInstanceId: "install-host-a",
            executors: new Map([["ses-mine", mine.executor]]),
        });

        await host.runner.pump("ses-mine");
        await mine.script.started;
        mine.script.settle({});
        await settle();

        expect(host.runner.inFlightSessions()).toEqual([]);
        expect(lane.reports.map((report) => report.runId)).toEqual(["run-mine"]);
        expect(lane.phaseOf("run-theirs")).toBe("pending");
        // Not merely "did not claim it": the loop never named it at all, because the
        // poll it answers is scoped to its own project.
        expect(lane.calls.some((call) => call.body.run_id === "run-theirs")).toBe(false);
        // And nothing the loop sent went out under another project's binding.
        expect(lane.calls.every((call) => call.project === "/projects/x")).toBe(true);
    });
});

/**
 * The seam that makes the project scope real.
 *
 * The lane's guarantee is enforced by the module against the channel's binding,
 * so it only protects this host if every op the loop sends rides a route bound to
 * the loop's own project. That is a property of the wiring, not of the loop, and
 * this is where it is pinned.
 */
describe("host runner project binding at the transform seam", () => {
    it("sends every claim-lane op on the transform's own project route", async () => {
        const project = process.cwd();
        const sessionId = "gate-project-binding";
        const providerID = "gate-provider";
        const modelID = "gate-model";
        const db = new Database(":memory:") as ContextDatabase;
        initializeDatabase(db);
        runMigrations(db);
        const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) => (after ? [] : [row].slice(0, limit)),
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "hello" }],
                createdAt: 1,
            }),
        });
        const messages: MessageLike[] = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID, modelID },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ];
        const laneCalls: Array<{ method: string; projectRoot: string }> = [];
        let rowVersion = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, projectRoot, body }) => {
                if (method.startsWith("historian.")) {
                    laneCalls.push({ method, projectRoot });
                }
                if (method === "historian.pending") {
                    return {
                        ok: true,
                        runs: [
                            {
                                run_id: "run-seam",
                                session_id: sessionId,
                                chunk_fingerprint: "fp",
                                prompt_bytes_len: 10,
                                deadline_ms: Date.now() + 600_000,
                            },
                        ],
                    };
                }
                if (method === "historian.claim") {
                    // Refused, so the pass stops after one claim. What is under test
                    // is which route the ops went out on, not the fold.
                    void body;
                    return { ok: false, refusal: "already_claimed" };
                }
                if (method !== "transform") return { ok: true };
                return {
                    decision: "HARD",
                    row_version: ++rowVersion,
                    rendered_memory_ids: [],
                    native_messages: structuredClone(messages),
                };
            },
        };
        const deps: TransformDeps = {
            tagger: {} as TransformDeps["tagger"],
            scheduler: {} as TransformDeps["scheduler"],
            contextUsageMap: new Map(),
            db,
            protectedTokens: 4,
            clearReasoningAge: 50,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            directory: project,
            projectPath: project,
            memoryConfig: { enabled: false, injectionBudgetTokens: 1, autoPromote: false },
            liveModelBySession: new Map([[sessionId, { providerID, modelID }]]),
            sessionDirectoryBySession: new Map([[sessionId, project]]),
            transformMode: "rust",
            rustModeModuleClient: moduleClient,
            historianRunner: "host",
        };
        const transform = createRustModeTransform(deps, {
            moduleClient,
            scheduleLkgCapture: (capture) => capture(),
            projectRoot: project,
        });
        try {
            const input = structuredClone(messages);
            await transform.run(
                sessionId,
                input,
                { messages: structuredClone(input) },
                getOrCreateSessionMeta(db, sessionId),
            );
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(laneCalls.map((call) => call.method)).toEqual([
                "historian.pending",
                "historian.claim",
            ]);
            expect(laneCalls.every((call) => call.projectRoot === project)).toBe(true);
        } finally {
            await transform.stopHostRunner();
            unregister();
            closeReadOnlySessionDb();
            resetLkgSlotsForTest();
            db.close();
        }
    });
});
