import { describe, expect, it } from "bun:test";
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

/**
 * A stand-in for the module's claim lane that follows the same rules the real one
 * does: the module mints the attempt and the token, a live lease refuses a second
 * claimant, an expired one admits the next, and a token that is no longer current
 * is refused wherever it is presented.
 *
 * It is deliberately not a recording of responses. Every test below turns on one
 * of those rules, so a stub that merely replayed canned bodies would pass while
 * the loop mishandled the rule the test is named for.
 */
class FakeClaimLane {
    readonly calls: Array<{ method: HistorianHostMethod; body: Record<string, unknown> }> = [];
    private readonly runs = new Map<
        string,
        {
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
    >();
    reports: Array<{ runId: string; body: Record<string, unknown> }> = [];
    now = 1_000;
    leaseMs = 600_000;
    /** Set to a refusal code to answer every `historian.pending` with it. */
    refusePending: string | null = null;

    queue(args: {
        runId: string;
        sessionId: string;
        modelChain?: string[];
        awaitBudgetMs?: number;
        system?: string;
        user?: string;
    }): void {
        const awaitBudgetMs = args.awaitBudgetMs ?? 660_000;
        this.runs.set(args.runId, {
            sessionId: args.sessionId,
            system: args.system ?? "system prompt",
            user: args.user ?? "user prompt",
            modelChain: args.modelChain ?? ["prov/first", "prov/second"],
            awaitBudgetMs,
            deadlineMs: this.now + awaitBudgetMs,
            attempt: 0,
            token: null,
            claimDeadlineMs: 0,
            reported: false,
        });
    }

    /** Take a run as if this lane's holder had vanished without saying so. */
    expireLease(runId: string): void {
        const run = this.runs.get(runId);
        if (run) run.claimDeadlineMs = this.now - 1;
    }

    call = async (args: {
        method: HistorianHostMethod;
        sessionId: string;
        body: Record<string, unknown>;
    }): Promise<unknown> => {
        this.calls.push({ method: args.method, body: args.body });
        const runId = String(args.body.run_id ?? "");
        const run = this.runs.get(runId);
        switch (args.method) {
            case "historian.pending": {
                if (this.refusePending) return { ok: false, refusal: this.refusePending };
                const runs = [...this.runs.entries()]
                    .filter(
                        ([, entry]) =>
                            !entry.reported &&
                            entry.deadlineMs > this.now &&
                            (entry.token === null || entry.claimDeadlineMs <= this.now),
                    )
                    .map(([id, entry]) => ({
                        run_id: id,
                        session_id: entry.sessionId,
                        chunk_fingerprint: "fp",
                        prompt_bytes_len: entry.system.length + entry.user.length,
                        deadline_ms: entry.deadlineMs,
                    }));
                return { ok: true, runs };
            }
            case "historian.claim": {
                if (!run) return { ok: false, refusal: "unknown_run" };
                if (run.reported || run.deadlineMs <= this.now) {
                    return { ok: false, refusal: "not_pending" };
                }
                if (run.token !== null && run.claimDeadlineMs > this.now) {
                    return { ok: false, refusal: "already_claimed" };
                }
                run.attempt += 1;
                run.token = `token-${runId}-${run.attempt}`;
                run.claimDeadlineMs = Math.min(this.now + this.leaseMs, run.deadlineMs);
                return {
                    ok: true,
                    run_id: runId,
                    session_id: run.sessionId,
                    attempt: run.attempt,
                    token: run.token,
                    prompt: { system: run.system, user: run.user },
                    model_chain: run.modelChain,
                    await_budget_ms: run.awaitBudgetMs,
                    claim_deadline_ms: run.claimDeadlineMs,
                    heartbeat_interval_ms: 30_000,
                };
            }
            case "historian.heartbeat": {
                if (!run) return { ok: false, refusal: "unknown_run" };
                if (run.token === null) return { ok: false, refusal: "not_claimed" };
                if (run.token !== args.body.token) {
                    return { ok: false, refusal: "superseded_token" };
                }
                // Past the run's own deadline the module has stopped waiting, so the
                // heartbeat refuses rather than handing back a lease already in the past.
                if (run.deadlineMs <= this.now) {
                    return { ok: false, refusal: "run_expired" };
                }
                run.claimDeadlineMs = Math.min(this.now + this.leaseMs, run.deadlineMs);
                return {
                    ok: true,
                    claim_deadline_ms: run.claimDeadlineMs,
                    heartbeat_interval_ms: 30_000,
                };
            }
            case "historian.complete": {
                if (!run) return { ok: false, refusal: "unknown_run" };
                if (run.token !== args.body.token) {
                    return { ok: false, refusal: "superseded_token" };
                }
                if (run.reported) return { ok: false, refusal: "already_reported" };
                run.reported = true;
                this.reports.push({ runId, body: args.body });
                return { ok: true, accepted: true, publish: "immediate" };
            }
        }
    };
}

interface ScriptedCompletion {
    /** Resolved when the loop asks this session's carrier for its output. */
    started: Promise<void>;
    settle(completion: Partial<HiddenCompletion>): void;
    fail(error: Error): void;
    closed: boolean;
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
    const script: ScriptedCompletion = {
        started,
        settle: (completion) =>
            settleOutput({
                text: completion.text ?? "<compartments/>",
                usage: completion.usage ?? { input: 0, output: 0, reasoning: 0, cache: 0 },
                lengthCapped: completion.lengthCapped ?? false,
            } as HiddenCompletion),
        fail: (error) => failOutput(error),
        closed: false,
    };
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open: async (): Promise<HiddenRunHandle> => ({ id: "child", childSessionId: "child" }),
        attempt: async () => {
            announceStarted();
        },
        collect: () => output,
        close: async () => {
            script.closed = true;
        },
    };
    return { executor, script };
}

function runnerOver(
    lane: FakeClaimLane,
    overrides: Partial<HistorianHostRunnerDeps> & {
        executors?: Map<string, HiddenCompletionExecutor>;
    } = {},
): { runner: HistorianHostRunner; logs: string[] } {
    const logs: string[] = [];
    const runner = new HistorianHostRunner({
        call: lane.call,
        claimantInstanceId: "install-uuid-one",
        openExecutor: (sessionId) => {
            const executor = overrides.executors?.get(sessionId);
            return executor ? { executor, sessionDirectory: "/tmp/project" } : undefined;
        },
        enabled: () => true,
        now: () => lane.now,
        log: (message) => logs.push(message),
        // Timers are never armed in these tests: heartbeats and the idle poll are
        // driven explicitly where they are the subject.
        schedule: () => () => {},
        ...overrides,
    });
    return { runner, logs };
}

/** Let the loop's own promise chain settle without advancing any timer. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("historian host runner", () => {
    it("claims a queued run and reports the completion the module can publish", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await script.started;
        script.settle({ text: "<compartments>fold</compartments>" });
        await settle();

        expect(lane.reports).toHaveLength(1);
        expect(lane.reports[0]?.runId).toBe("run-a");
        expect(lane.reports[0]?.body.output).toEqual({
            text: "<compartments>fold</compartments>",
            length_capped: false,
        });
        expect(lane.reports[0]?.body.token).toBe("token-run-a-1");
    });

    it("passes a length-capped answer through instead of deciding for the module", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await script.started;
        script.settle({ text: "<compartments>cut", lengthCapped: true });
        await settle();

        // The module refuses a length-capped document with its own rule and its own
        // diagnostic. Hiding it here would turn that into a vague host-side failure.
        expect(lane.reports[0]?.body.output).toEqual({
            text: "<compartments>cut",
            length_capped: true,
        });
    });

    it("takes the next run when another claimant already holds the first", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        lane.queue({ runId: "run-b", sessionId: "ses-b" });
        // Somebody else took run-a a moment ago and is still holding it.
        await lane.call({
            method: "historian.claim",
            sessionId: "ses-a",
            body: { run_id: "run-a", claimant_instance_id: "install-uuid-two" },
        });
        const { executor, script } = scriptedExecutor();
        const { runner, logs } = runnerOver(lane, { executors: new Map([["ses-b", executor]]) });

        await runner.pump("ses-b");
        await script.started;
        script.settle({});
        await settle();

        expect(lane.reports.map((report) => report.runId)).toEqual(["run-b"]);
        expect(
            logs.some((line) => line.includes("run-a") && line.includes("already_claimed")),
        ).toBe(false);
    });

    it("refuses a second claim for a session it is already running", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a1", sessionId: "ses-a" });
        lane.queue({ runId: "run-a2", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await script.started;

        expect(runner.inFlightSessions()).toEqual(["ses-a"]);
        expect(lane.calls.filter((call) => call.method === "historian.claim")).toHaveLength(1);

        script.settle({});
        await settle();
    });

    it("keeps claiming for other sessions while one session's fold runs", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        lane.queue({ runId: "run-b", sessionId: "ses-b" });
        const slow = scriptedExecutor();
        const quick = scriptedExecutor();
        const { runner } = runnerOver(lane, {
            executors: new Map([
                ["ses-a", slow.executor],
                ["ses-b", quick.executor],
            ]),
        });

        // ses-a is claimed first and never finishes during this pump. If the loop
        // waited for it, ses-b would never be claimed at all.
        await runner.pump("ses-a");
        await quick.script.started;
        expect(runner.inFlightSessions().sort()).toEqual(["ses-a", "ses-b"]);

        quick.script.settle({});
        await settle();
        expect(lane.reports.map((report) => report.runId)).toEqual(["run-b"]);
        expect(runner.inFlightSessions()).toEqual(["ses-a"]);

        slow.script.settle({});
        await settle();
        expect(lane.reports.map((report) => report.runId).sort()).toEqual(["run-a", "run-b"]);
    });

    it("does not claim a run the module has almost stopped waiting for", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", awaitBudgetMs: 1_000 });
        const { executor } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await settle();

        expect(lane.calls.filter((call) => call.method === "historian.claim")).toHaveLength(0);
        expect(runner.inFlightSessions()).toEqual([]);
    });

    it("abandons a claim it has lost and never reports under a dead token", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        // Heartbeats are driven by hand so the loss is observed at a known point.
        const beats: Array<() => void> = [];
        const { runner, logs } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            schedule: (callback) => {
                beats.push(callback);
                return () => {};
            },
        });

        await runner.pump("ses-a");
        await script.started;

        // The lease lapses and a second claimant takes the run under a new token.
        lane.expireLease("run-a");
        await lane.call({
            method: "historian.claim",
            sessionId: "ses-a",
            body: { run_id: "run-a", claimant_instance_id: "install-uuid-two" },
        });

        beats.at(0)?.();
        await settle();
        script.fail(new Error("aborted by the loop"));
        await settle();

        expect(logs.some((line) => line.includes("superseded_token"))).toBe(true);
        expect(lane.reports).toHaveLength(0);
        expect(runner.inFlightSessions()).toEqual([]);
    });

    it("stops the completion when the module says the run itself expired", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const beats: Array<() => void> = [];
        const { runner, logs } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            schedule: (callback) => {
                beats.push(callback);
                return () => {};
            },
        });

        await runner.pump("ses-a");
        await script.started;

        // The run outlived its own deadline while this host was still working. The
        // module has stopped waiting, so continuing would be spend against nobody.
        lane.now = lane.now + 660_001;
        beats.at(0)?.();
        await settle();
        script.fail(new Error("aborted by the loop"));
        await settle();

        expect(logs.some((line) => line.includes("run_expired"))).toBe(true);
        expect(lane.reports).toHaveLength(0);
        expect(runner.inFlightSessions()).toEqual([]);
    });

    it("says once when the module refuses this host's poll outright", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        lane.refusePending = "route_unbound";
        const { executor } = scriptedExecutor();
        const { runner, logs } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
        });

        await runner.pump("ses-a");
        await runner.pump("ses-a");
        await settle();

        expect(lane.calls.filter((call) => call.method === "historian.claim")).toHaveLength(0);
        expect(logs.filter((line) => line.includes("route_unbound"))).toHaveLength(1);
    });

    it("sends the wire version on every op so the module can refuse an unknown one", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const beats: Array<() => void> = [];
        const { runner } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            schedule: (callback) => {
                beats.push(callback);
                return () => {};
            },
        });

        await runner.pump("ses-a");
        await script.started;
        beats.at(0)?.();
        await settle();
        script.settle({});
        await settle();

        const methods = new Set(lane.calls.map((call) => call.method));
        expect([...methods].sort()).toEqual([
            "historian.claim",
            "historian.complete",
            "historian.heartbeat",
            "historian.pending",
        ]);
        expect(lane.calls.every((call) => call.body.v === 1)).toBe(true);
    });

    it("reports a typed failure when every model in the chain refuses", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", modelChain: ["prov/only"] });
        const { executor, script } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await script.started;
        script.fail(new Error("provider refused"));
        await settle();

        expect(lane.reports).toHaveLength(1);
        const error = lane.reports[0]?.body.error as { code: string; message: string };
        expect(error.code).toBe("run_failed");
        expect(error.message).toContain("provider refused");
    });

    it("gives each model the host's historian_timeout_ms, not the whole await budget", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", modelChain: ["prov/only"] });
        // The model never answers; the dispatch ends only when its signal aborts. The
        // run-level deadline timer is disabled by the harness, so only the
        // per-attempt timeout can end this run.
        const { executor } = scriptedExecutor();
        const attempted: number[] = [];
        executor.attempt = (_handle, request) =>
            new Promise((_resolve, reject) => {
                attempted.push(Date.now());
                request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        const { runner } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            attemptTimeoutMs: () => 25,
        });

        await runner.pump("ses-a");
        for (let i = 0; i < 40 && lane.reports.length === 0; i += 1) await Bun.sleep(10);

        expect(attempted).toHaveLength(1);
        expect(lane.reports).toHaveLength(1);
        const error = lane.reports[0]?.body.error as { code: string; message: string };
        expect(error.message).toContain("timed out after 25ms");
        expect(runner.inFlightSessions()).toEqual([]);
    });

    it("claims nothing while the kill switch is off, and says so once", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor } = scriptedExecutor();
        let enabled = false;
        const { runner, logs } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            enabled: () => enabled,
        });

        await runner.pump("ses-a");
        await runner.pump("ses-a");
        await settle();

        expect(lane.calls).toHaveLength(0);
        expect(logs.filter((line) => line.includes("host_runner.enabled=false"))).toHaveLength(1);

        // Turning it back on needs no restart: the next pass claims.
        enabled = true;
        await runner.pump("ses-a");
        await settle();
        expect(lane.calls.filter((call) => call.method === "historian.claim")).toHaveLength(1);
    });

    it("reports a claim it cannot run rather than sitting on it", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a", modelChain: [] });
        const { runner } = runnerOver(lane, { executors: new Map() });

        await runner.pump("ses-a");
        await settle();

        expect((lane.reports[0]?.body.error as { code: string }).code).toBe("no_models");
        expect(runner.inFlightSessions()).toEqual([]);
    });

    it("hands a killed host's run to a second host once the lease lapses", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const first = scriptedExecutor();
        const second = scriptedExecutor();
        const firstHost = new HistorianHostRunner({
            call: lane.call,
            claimantInstanceId: "install-uuid-one",
            openExecutor: () => ({
                executor: first.executor,
                sessionDirectory: "/tmp/project",
            }),
            enabled: () => true,
            now: () => lane.now,
            log: () => {},
            schedule: () => () => {},
        });
        const secondLogs: string[] = [];
        const secondHost = new HistorianHostRunner({
            call: lane.call,
            claimantInstanceId: "install-uuid-two",
            openExecutor: () => ({
                executor: second.executor,
                sessionDirectory: "/tmp/project",
            }),
            enabled: () => true,
            now: () => lane.now,
            log: (message) => secondLogs.push(message),
            schedule: () => () => {},
        });

        await firstHost.pump("ses-a");
        await first.script.started;

        // While the first host is alive and holding the lease, the second is refused.
        await secondHost.pump("ses-a");
        await settle();
        expect(secondHost.inFlightSessions()).toEqual([]);

        // The first host is killed mid-claim: no report, no heartbeat, nothing said.
        // Only the lease recovers the run.
        lane.expireLease("run-a");
        await secondHost.pump("ses-a");
        await second.script.started;
        expect(secondHost.inFlightSessions()).toEqual(["ses-a"]);

        second.script.settle({ text: "<compartments>second host</compartments>" });
        await settle();
        expect(lane.reports).toHaveLength(1);
        expect(lane.reports[0]?.body.token).toBe("token-run-a-2");

        // The killed host coming back with its old answer changes nothing: the token
        // it holds names an attempt that no longer exists.
        const late = await lane.call({
            method: "historian.complete",
            sessionId: "ses-a",
            body: {
                run_id: "run-a",
                token: "token-run-a-1",
                output: { text: "<compartments>first host</compartments>" },
            },
        });
        expect(late).toEqual({ ok: false, refusal: "superseded_token" });
    });

    it("does not start a run whose claim answer arrives after the loop was stopped", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        let started = false;
        void script.started.then(() => {
            started = true;
        });
        let stopping: Promise<void> | null = null;
        const { runner } = runnerOver(lane, {
            executors: new Map([["ses-a", executor]]),
            // Shutdown lands while the claim is on the wire.
            call: async (args) => {
                if (args.method === "historian.claim") stopping = runner.stop();
                return lane.call(args);
            },
        });

        await runner.pump("ses-a");
        await stopping;
        await settle();

        expect(started).toBe(false);
        expect(runner.inFlightSessions()).toEqual([]);
        expect(lane.reports).toHaveLength(0);
    });

    it("stops holding a claim when the loop is stopped", async () => {
        const lane = new FakeClaimLane();
        lane.queue({ runId: "run-a", sessionId: "ses-a" });
        const { executor, script } = scriptedExecutor();
        const { runner } = runnerOver(lane, { executors: new Map([["ses-a", executor]]) });

        await runner.pump("ses-a");
        await script.started;
        const stopping = runner.stop();
        script.fail(new Error("aborted"));
        await stopping;

        expect(runner.inFlightSessions()).toEqual([]);
        // Nothing is reported: the module's lease is what recovers an abandoned run,
        // and that is the same path a crashed host takes.
        expect(lane.reports).toHaveLength(0);
    });
});
