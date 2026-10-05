/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    __resetChildSpawnFenceProbeForTests,
    type ChildSpawnFenceFailure,
} from "../../features/magic-context/schema-fence-probe";
import {
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../../features/magic-context/storage-db";
import {
    __resetNotificationStateForTests,
    drainNotifications,
} from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import {
    createChildSessionWithFence,
    SCHEMA_PROBE_FAILURE_NOTICE,
    STALE_PLUGIN_RESTART_NOTICE,
} from "./child-session-spawn";

import { __ignoredNotificationTest } from "./send-session-notification";

// Schema-warning delivery is exercised with an idle parent, not an active model loop.
beforeEach(() => __ignoredNotificationTest.setHoldDetector(() => false));
const dbs: Database[] = [];

function staleDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)",
    ).run(LATEST_SUPPORTED_VERSION + 1, "future schema", Date.now());
    dbs.push(db);
    return db;
}

afterEach(() => {
    __ignoredNotificationTest.reset();
    __resetChildSpawnFenceProbeForTests();
    __resetNotificationStateForTests();
    for (const db of dbs.splice(0)) db.close();
});

describe("createChildSessionWithFence", () => {
    it("does not attempt session.create when the live schema is newer", async () => {
        const create = mock(async () => ({ id: "child" }));
        const client = { session: { create } } as never;
        const latchedFailures: ChildSpawnFenceFailure[] = [];
        const args = {
            client,
            db: staleDatabase(),
            parentSessionId: "ses_parent",
            title: "magic-context-dreamer",
            directory: "/project",
            onFenceLatched: (failure: ChildSpawnFenceFailure) => latchedFailures.push(failure),
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        // Removing the fence call makes this mock run twice, so the spawn guard
        // is observed directly rather than inferred from a matching return value.
        expect(create).not.toHaveBeenCalled();
        expect(latchedFailures).toHaveLength(1);
        expect(latchedFailures[0]).toMatchObject({
            persistedVersion: LATEST_SUPPORTED_VERSION + 1,
            supportedVersion: LATEST_SUPPORTED_VERSION,
            consecutiveFailures: 2,
        });
    });

    it("refuses an unreadable probe and surfaces the doctor recovery message", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        db.close();
        const create = mock(async () => ({ id: "child" }));
        const prompt = mock(async () => undefined);
        const client = { session: { create, prompt } } as never;
        const args = {
            client,
            db,
            parentSessionId: "ses_parent",
            title: "magic-context-dreamer",
            directory: "/project",
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        expect(create).not.toHaveBeenCalled();
        expect(drainNotifications(0, "ses_parent")).toContainEqual(
            expect.objectContaining({
                type: "toast",
                payload: expect.objectContaining({ message: SCHEMA_PROBE_FAILURE_NOTICE }),
            }),
        );
        expect(prompt).not.toHaveBeenCalled();
    });

    it("surfaces the latched failure through RPC and persisted sidebar state without a parent chat row", async () => {
        const db = staleDatabase();
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses_parent");
        const create = mock(async () => ({ id: "child" }));
        const prompt = mock(async () => undefined);
        const client = { session: { create, prompt } } as never;
        const args = {
            client,
            db,
            parentSessionId: "ses_parent",
            title: "magic-context-dreamer",
            directory: "/project",
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        const notifications = drainNotifications(0, "ses_parent");
        expect(notifications).toContainEqual(
            expect.objectContaining({
                type: "toast",
                payload: expect.objectContaining({
                    message: STALE_PLUGIN_RESTART_NOTICE,
                    variant: "error",
                }),
            }),
        );
        expect(notifications).toContainEqual(
            expect.objectContaining({ type: "action", payload: { action: "refresh-sidebar" } }),
        );
        expect(prompt).not.toHaveBeenCalled();
        expect(
            db
                .prepare("SELECT last_transform_error FROM session_meta WHERE session_id = ?")
                .get("ses_parent"),
        ).toEqual({ last_transform_error: STALE_PLUGIN_RESTART_NOTICE });
    });
});

it("defers parentless dreamer work without creating a visible root", async () => {
    const create = mock(async () => ({ id: "child" }));
    const result = await createChildSessionWithFence({
        client: { session: { create } },
        db: null,
        title: "magic-context-dream-map-memories",
        directory: "/project",
    });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
});

it("creates dreamer sessions with the ordinary parent relationship", async () => {
    const create = mock(async () => ({ id: "child" }));
    await createChildSessionWithFence({
        client: { session: { create } },
        db: null,
        parentSessionId: "ses_parent",
        title: "magic-context-dream-verify",
        directory: "/project",
    });
    expect(create).toHaveBeenCalledWith({
        body: { parentID: "ses_parent", title: "magic-context-dream-verify" },
        query: { directory: "/project" },
    });
});

it("creates parentless process-local dreamer sessions without exposing a host root", async () => {
    const create = mock(async () => ({ id: "hidden-child" }));
    const result = await createChildSessionWithFence({
        client: { backgroundSessionsAreHidden: true, session: { create } },
        db: null,
        title: "magic-context-dream-curate",
        directory: "/project",
    });
    expect(result).toEqual({ id: "hidden-child" });
    expect(create).toHaveBeenCalledWith({
        body: { title: "magic-context-dream-curate" },
        query: { directory: "/project" },
    });
});
