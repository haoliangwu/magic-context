import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { _getDreamTimerStateForTests, _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { _resetHarnessForTesting } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { setup } from "../server";
import { V2StoreReader } from "../store-reader";
import { registerContext } from "./context";
import { findV2DreamParentSession } from "./dream-timer";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

/**
 * OpenCode 2 calls only `setup`, never the OpenCode 1 `server` function that
 * registers the dream schedule timer. These tests pin that the v2 lane
 * registers its project with the process-wide timer and that a context's
 * cleanup (what OpenCode 2 runs when a location shuts down) takes it off again.
 */

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    _resetHarnessForTesting();
    for (const dir of directories.splice(0)) cleanupTestTempDir(dir);
});

function projectDirectory(): string {
    const { dir } = createTestTempDir("mc-v2-dream-timer-");
    directories.push(dir);
    return dir;
}

function fakeHost(directory: string): V2Context {
    return {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async () => {},
            get: async () => ({ location: { directory } }),
        },
    } as unknown as V2Context;
}

/** A configuration with the dreamer on, and nothing else that starts background work. */
function mockConfig(dreamer: { disable: boolean }) {
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        historian: { disable: true },
        dreamer,
        memory: { enabled: false },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    // Storage opens at boot, so the dreamer's carrier is wired during setup.
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    disposers.push(async () => {
        load.mockRestore();
        probe.mockRestore();
    });
}

describe("OpenCode 2 dream schedule timer registration", () => {
    test("setup registers the project with the schedule timer and its cleanup unregisters it", async () => {
        mockConfig({ disable: false });
        const directory = projectDirectory();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });

        const dispose = await setup(fakeHost(directory));
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        await dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });

    test("a disabled dreamer registers nothing", async () => {
        mockConfig({ disable: true });
        const dispose = await setup(fakeHost(projectDirectory()));
        disposers.unshift(dispose);
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });

    test("several contexts share one timer, and each cleanup removes only its own project", async () => {
        mockConfig({ disable: false });
        const first = projectDirectory();
        const second = projectDirectory();
        const intervals = spyOn(globalThis, "setInterval");
        disposers.push(async () => intervals.mockRestore());

        const firstContext = await registerContext(fakeHost(first));
        const secondContext = await registerContext(fakeHost(second));
        // Two projects on the timer, but only one interval in the process.
        expect(_getDreamTimerStateForTests()).toEqual({
            active: true,
            directories: [first, second],
        });
        const dreamTimerIntervals = intervals.mock.calls.filter(
            ([, ms]) => ms === 15 * 60 * 1000,
        ).length;
        expect(dreamTimerIntervals).toBe(1);

        await firstContext?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [second] });

        await secondContext?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });

    test("a location rebuilt in place keeps the replacement's registration when the old one is disposed", async () => {
        mockConfig({ disable: false });
        const directory = projectDirectory();

        const previous = await registerContext(fakeHost(directory));
        const replacement = await registerContext(fakeHost(directory));
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        // The old location's cleanup runs after its replacement registered.
        await previous?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        await replacement?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });
});

/** The OpenCode 2 session table, as far as the parent lookup reads it. */
function createV2Store(
    rows: Array<{
        id: string;
        directory: string;
        parent_id?: string;
        metadata?: string;
        time_updated: number;
        time_archived?: number;
    }>,
): string {
    const dir = projectDirectory();
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL,
            parent_id TEXT, metadata TEXT, time_updated INTEGER NOT NULL, time_archived INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);`);
    const insert = db.prepare(
        "INSERT INTO session_v2 (id, directory, parent_id, metadata, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows)
        insert.run(
            row.id,
            row.directory,
            row.parent_id ?? null,
            row.metadata ?? null,
            row.time_updated,
            row.time_archived ?? null,
        );
    db.close();
    return path;
}

describe("OpenCode 2 timer parent lookup", () => {
    test("picks the latest top-level user session in this directory only", () => {
        const path = createV2Store([
            { id: "ses-old", directory: "/work/app", time_updated: 1 },
            { id: "ses-latest", directory: "/work/app", time_updated: 5 },
            { id: "ses-child", directory: "/work/app", parent_id: "ses-old", time_updated: 9 },
            {
                id: "ses-hidden",
                directory: "/work/app",
                metadata: JSON.stringify({ magic_context: "hidden-run", role: "dreamer" }),
                time_updated: 9,
            },
            { id: "ses-archived", directory: "/work/app", time_updated: 9, time_archived: 9 },
            { id: "ses-sibling", directory: "/work/app-worktree", time_updated: 9 },
        ]);
        expect(findV2DreamParentSession(() => new V2StoreReader(path), "/work/app")).toBe(
            "ses-latest",
        );
    });

    test("finds nothing in a directory without a user session, and nothing when the store cannot be read", () => {
        const path = createV2Store([
            { id: "ses-sibling", directory: "/work/app-worktree", time_updated: 9 },
        ]);
        expect(
            findV2DreamParentSession(() => new V2StoreReader(path), "/work/app"),
        ).toBeUndefined();
        expect(
            findV2DreamParentSession(() => {
                throw new Error("store missing");
            }, "/work/app"),
        ).toBeUndefined();
    });
});
