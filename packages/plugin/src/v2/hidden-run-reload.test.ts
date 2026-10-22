import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import {
    getPromptFailureDetail,
    promptSyncWithValidatedOutputRetry,
} from "../shared/model-suggestion-retry";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    createV2HiddenCompletionExecutor,
    type HiddenChildHost,
    type HiddenChildRows,
} from "./hidden-completion";
import {
    __resetDisposedChildrenForTests,
    HIDDEN_RUN_DISPOSED_REASON,
    HiddenChildHook,
    hiddenToolCallRefusal,
} from "./hooks/hidden-child";
import type { SessionContext } from "./hooks/types";
import { type StoreRow, V2StoreReaderPool } from "./store-reader";

/**
 * A plugin reload on OpenCode 2 (2.0.32), modelled on the host's own code:
 *
 * - `PluginRegistry.activate` closes the old instance's plugin scope. Scope
 *   finalizers run in reverse order, and the Promise adapter adds the plugin's
 *   disposer after `setup` has registered its hooks, so the disposer runs first
 *   while the old hooks are still registered; the hook registrations go next;
 *   then the new instance's `setup` registers its own hooks.
 * - Hooks are per location (`PluginHooks`), and every step triggers whatever is
 *   registered at that moment. A drain already running keeps stepping across the
 *   reload; a drain started during it waits for activation first
 *   (`plugins.awaitActivation` in `SessionRunner.drain`).
 * - Session drains run on the session layer's own fibers, so the old instance's
 *   prompt, wait and interrupt calls keep working after its scope is closed.
 * - `session.interrupt` interrupts the drain fiber; no further step runs.
 */

const historian: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian",
    kind: "historian",
    system: "calibrated historian system",
    model: "mock/cheap",
    timeoutMs: 5_000,
    title: "historian",
    directory: "/project",
};

const request = () => ({
    path: { id: "child" },
    body: {
        model: { providerID: "mock", modelID: "cheap" },
        parts: [{ type: "text", text: "calibrated chunk", synthetic: true }],
    },
});

class Rows implements HiddenChildRows {
    private readonly assistants = new Map<string, StoreRow<"assistant">[]>();
    private readonly idles = new Map<string, StoreRow<"idle">[]>();
    private seq = 0;

    latestSequence(sessionID: string): number {
        return Math.max(
            this.assistants.get(sessionID)?.at(-1)?.seq ?? -1,
            this.idles.get(sessionID)?.at(-1)?.seq ?? -1,
        );
    }
    assistantSince(sessionID: string, afterSeq: number): StoreRow<"assistant">[] {
        return (this.assistants.get(sessionID) ?? []).filter((row) => row.seq > afterSeq);
    }
    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        return this.assistants.get(sessionID)?.at(-1);
    }
    latestIdle(sessionID: string): StoreRow<"idle"> | undefined {
        return this.idles.get(sessionID)?.at(-1);
    }
    assistant(sessionID: string, text: string, finish = "stop"): void {
        const list = this.assistants.get(sessionID) ?? [];
        list.push({
            id: `m-${++this.seq}`,
            session_id: sessionID,
            type: "assistant",
            seq: this.seq,
            data: {
                content: [{ type: "text", text }],
                finish,
                model: { providerID: "mock", id: "cheap" },
                tokens: { input: 10, output: 2, reasoning: 0 },
                time: { created: Date.now(), completed: Date.now() },
            },
        } as StoreRow<"assistant">);
        this.assistants.set(sessionID, list);
    }
    idle(sessionID: string, outcome: "succeeded" | "failed" | "interrupted"): void {
        const list = this.idles.get(sessionID) ?? [];
        list.push({
            id: `m-${++this.seq}`,
            session_id: sessionID,
            type: "idle",
            seq: this.seq,
            data: { outcome, time: { created: Date.now() } },
        });
        this.idles.set(sessionID, list);
    }
}

interface RegisteredHook {
    owner: string;
    hook: HiddenChildHook;
}

/** The host side of the model: one location, its hook registry, and session drains. */
function fakeLocation(options: { steps: number; interruptStopsDrain?: boolean }) {
    const rows = new Rows();
    const hooks: RegisteredHook[] = [];
    const agents = new Map<string, string>();
    const interrupted = new Set<string>();
    const interruptCalls: string[] = [];
    const removed: string[] = [];
    const hostErrors: Array<{ sessionID: string; owner: string; error: unknown }> = [];
    const dispatched: Array<{ sessionID: string; owner: string; step: number }> = [];
    const drains = new Map<string, Promise<void>>();
    const wakeInterrupt = new Map<string, () => void>();
    let activation: Promise<void> = Promise.resolve();
    let stepOneDone!: () => void;
    const firstStep = new Promise<void>((resolve) => {
        stepOneDone = resolve;
    });
    let releaseStepTwo!: () => void;
    const stepTwo = new Promise<void>((resolve) => {
        releaseStepTwo = resolve;
    });
    let next = 0;

    const drain = async (sessionID: string, marker: string): Promise<void> => {
        // SessionRunner.drain awaits plugin activation once, at its start.
        await activation;
        const stopped = new Promise<void>((resolve) => wakeInterrupt.set(sessionID, resolve));
        const messages: SessionContext["messages"] = [
            { role: "user", content: [{ type: "text", text: marker }] },
        ];
        for (let step = 1; step <= options.steps; step++) {
            if (interrupted.has(sessionID)) {
                rows.idle(sessionID, "interrupted");
                return;
            }
            const draft: SessionContext = {
                sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: agents.get(sessionID),
                system: [{ type: "text", text: "host system" }],
                tools: {},
                options: {},
                messages: structuredClone(messages),
            };
            // PluginHooks.trigger: whatever is registered when the step runs.
            for (const entry of [...hooks]) {
                dispatched.push({ sessionID, owner: entry.owner, step });
                try {
                    entry.hook.apply(draft);
                } catch (error) {
                    // The hook threw, so the host ends this drain as failed; OpenCode
                    // logs that as "Failed to drain Session" and shows the session failed.
                    hostErrors.push({ sessionID, owner: entry.owner, error });
                    rows.idle(sessionID, "failed");
                    return;
                }
            }
            if (step < options.steps) {
                messages.push({
                    role: "assistant",
                    content: [{ type: "text", text: `step ${step}` }],
                });
                if (step === 1) stepOneDone();
                // The model call; an interrupt ends it.
                await Promise.race([stepTwo, stopped]);
                continue;
            }
            rows.assistant(sessionID, "historian output");
            rows.idle(sessionID, "succeeded");
        }
    };

    const host: HiddenChildHost = {
        async create(input) {
            const id = `child-${++next}`;
            agents.set(id, input.agent);
            return { id };
        },
        async get() {
            return { model: { providerID: "mock", id: "cheap" } };
        },
        async switchModel() {},
        async prompt(input) {
            drains.set(input.sessionID, drain(input.sessionID, input.text));
        },
        async wait(input) {
            await drains.get(input.sessionID);
        },
        async interrupt(input) {
            interruptCalls.push(input.sessionID);
            if (options.interruptStopsDrain === false) return { interrupted: false };
            interrupted.add(input.sessionID);
            wakeInterrupt.get(input.sessionID)?.();
            return { interrupted: true };
        },
        async update() {},
        async removeSession(input) {
            removed.push(input.sessionID);
        },
    };

    /**
     * PluginRegistry.activate for one changed plugin: activation is held, the old
     * scope closes (disposer first, then its hooks), the new instance loads.
     */
    const reload = async (
        old: RegisteredHook,
        dispose: () => Promise<void>,
        fresh: RegisteredHook,
    ) => {
        let activated!: () => void;
        activation = new Promise<void>((resolve) => {
            activated = resolve;
        });
        await dispose();
        hooks.splice(hooks.indexOf(old), 1);
        hooks.push(fresh);
        activated();
    };

    return {
        rows,
        hooks,
        host,
        firstStep,
        releaseStepTwo,
        reload,
        interruptCalls,
        removed,
        hostErrors,
        dispatched,
    };
}

const roots: string[] = [];

function storeFile(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-issue-735-"));
    roots.push(root);
    const path = join(root, "opencode.db");
    const writer = new BunDatabase(path);
    writer.exec(
        "CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
    );
    writer.close();
    return path;
}

afterEach(() => {
    __resetDisposedChildrenForTests();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One Magic Context instance as `registerContext` wires it: hook, pool, executor. */
async function instance(
    location: ReturnType<typeof fakeLocation>,
    owner: string,
    options: { holdStore: boolean },
) {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const path = storeFile();
    const pool = new V2StoreReaderPool();
    const hook = new HiddenChildHook(() => {});
    // Every read goes through the real pool, as `openStoreReader` does, so a
    // closed pool fails here with the production error.
    const openReader = () => {
        const lease = pool.open(path);
        return {
            latestSequence: (id: string) => location.rows.latestSequence(id),
            latestAssistant: (id: string) => location.rows.latestAssistant(id),
            assistantSince: (id: string, after: number) => location.rows.assistantSince(id, after),
            latestIdle: (id: string) => location.rows.latestIdle(id),
            close: () => lease.close(),
        };
    };
    const executor = await createV2HiddenCompletionExecutor(location.host, {
        db,
        projectIdentity: "/project",
        directory: "/project",
        hook,
        openReader,
        log: () => {},
        ...(options.holdStore ? { holdStore: () => pool.hold() } : {}),
    });
    return { owner, db, pool, hook, executor, registered: { owner, hook } };
}

const settlement = {
    promptSettled: false,
    privacySensitive: false,
    context: "historian",
    log() {},
};

describe("OpenCode 2 plugin reload with a hidden run in flight", () => {
    test("reproduces the reported failure when the disposer only closes the pool", async () => {
        const location = fakeLocation({ steps: 2 });
        const old = await instance(location, "old", { holdStore: false });
        const fresh = await instance(location, "new", { holdStore: false });
        location.hooks.push(old.registered);
        const handle = await old.executor.open(historian);
        const running = old.executor.attempt(handle, request());
        running.catch(() => {});
        await location.firstStep;

        // The disposer this plugin shipped before the fix: close the pool, nothing else.
        await location.reload(old.registered, async () => old.pool.close(), fresh.registered);
        location.releaseStepTwo();

        const caught = await running.then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(String(caught)).toContain("Store reader pool is closed");
        expect(location.hostErrors).toHaveLength(1);
        expect(location.hostErrors[0]?.owner).toBe("new");
        expect(String(location.hostErrors[0]?.error)).toContain(
            "Refusing a Magic Context hidden-agent turn this instance did not register",
        );
        old.db.close();
        fresh.db.close();
    });

    test("cancels the run with the named disposal reason, never a closed pool, and the new instance never drives it", async () => {
        const location = fakeLocation({ steps: 2 });
        const old = await instance(location, "old", { holdStore: true });
        const fresh = await instance(location, "new", { holdStore: true });
        location.hooks.push(old.registered);
        const handle = await old.executor.open(historian);
        const running = promptSyncWithValidatedOutputRetry(undefined, request(), {
            transport: (args) => old.executor.attempt(handle, args),
            fetchOutput: async () => (await old.executor.collect(handle)).text ?? "",
            validateOutput: (value) => value,
        });
        running.catch(() => {});
        await location.firstStep;

        // The disposer's hidden-run part, in registerContext's order: cancel the
        // runs, then close the pool once idle.
        let poolClosedWithinDispose = false;
        await location.reload(
            old.registered,
            async () => {
                await old.executor.dispose();
                poolClosedWithinDispose = await old.pool.closeWhenIdle(50);
            },
            fresh.registered,
        );
        location.releaseStepTwo();

        const caught = await running.then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(HiddenCompletionRefusal);
        expect((caught as HiddenCompletionRefusal).code).toBe("hidden_instance_disposed");
        expect(String(caught)).toContain(HIDDEN_RUN_DISPOSED_REASON);
        expect(String(caught)).not.toContain("Store reader pool is closed");
        expect(getPromptFailureDetail(caught)?.failureClass).toBe("local_refusal");
        expect(getPromptFailureDetail(caught)?.modelsTried).toHaveLength(1);
        // Interrupted while the old hooks still served it: no step of this child
        // ever reached the new instance, and the host reported no drain failure.
        expect(location.interruptCalls).toEqual([handle.childSessionId]);
        expect(location.dispatched.filter((entry) => entry.owner === "new")).toEqual([]);
        expect(location.hostErrors).toEqual([]);
        // The run's hold kept the pool open past dispose; the run's close releases it.
        expect(poolClosedWithinDispose).toBe(false);
        expect(old.pool.isClosed()).toBe(false);
        await old.executor.close(handle, settlement);
        expect(old.pool.isClosed()).toBe(true);
        expect(location.removed).toContain(handle.childSessionId);
        // The disposed instance starts nothing more.
        await expect(old.executor.open(historian)).rejects.toThrow(HIDDEN_RUN_DISPOSED_REASON);
        old.db.close();
        fresh.db.close();
    });

    test("a turn that still reaches the new instance is refused with the same reason", async () => {
        // A host whose interrupt does not stop the drain: the next step lands on
        // the new instance's hook after the reload.
        const location = fakeLocation({ steps: 2, interruptStopsDrain: false });
        const old = await instance(location, "old", { holdStore: true });
        const fresh = await instance(location, "new", { holdStore: true });
        location.hooks.push(old.registered);
        const handle = await old.executor.open(historian);
        const running = old.executor.attempt(handle, request());
        running.catch(() => {});
        await location.firstStep;

        await location.reload(
            old.registered,
            async () => {
                await old.executor.dispose();
                await old.pool.closeWhenIdle(50);
            },
            fresh.registered,
        );
        const caught = await running.then(
            () => undefined,
            (error: unknown) => error,
        );
        location.releaseStepTwo();
        await location.host.wait({ sessionID: handle.childSessionId });

        expect((caught as HiddenCompletionRefusal).code).toBe("hidden_instance_disposed");
        expect(location.hostErrors).toHaveLength(1);
        const refusal = location.hostErrors[0]?.error as HiddenCompletionRefusal;
        expect(location.hostErrors[0]?.owner).toBe("new");
        expect(refusal).toBeInstanceOf(HiddenCompletionRefusal);
        expect(refusal.code).toBe("hidden_instance_disposed");
        expect(refusal.message).toContain(HIDDEN_RUN_DISPOSED_REASON);
        // Its tool calls are refused there too, even one on the agent's allowlist.
        expect(
            hiddenToolCallRefusal(
                { tool: "ctx_memory", sessionID: handle.childSessionId, agent: "dreamer" },
                fresh.hook,
            ),
        ).toContain(HIDDEN_RUN_DISPOSED_REASON);
        await old.executor.close(handle, settlement);
        old.db.close();
        fresh.db.close();
    });

    test("a run that settled before the reload completes, and the pool closes within dispose", async () => {
        const location = fakeLocation({ steps: 1 });
        const old = await instance(location, "old", { holdStore: true });
        const fresh = await instance(location, "new", { holdStore: true });
        location.hooks.push(old.registered);
        const handle = await old.executor.open(historian);
        await old.executor.attempt(handle, request());
        expect((await old.executor.collect(handle)).text).toBe("historian output");
        await old.executor.close(handle, { ...settlement, promptSettled: true });

        let closed = false;
        await location.reload(
            old.registered,
            async () => {
                await old.executor.dispose();
                closed = await old.pool.closeWhenIdle(50);
            },
            fresh.registered,
        );
        expect(closed).toBe(true);
        expect(location.interruptCalls).toEqual([]);
        old.db.close();
        fresh.db.close();
    });
});
