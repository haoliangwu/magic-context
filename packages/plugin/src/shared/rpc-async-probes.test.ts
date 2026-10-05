import { afterEach, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetSchemaFenceStateForTests,
    getMigrationOnOpenRefusal,
    openDatabaseAsync,
} from "../features/magic-context/storage-db";
import { createV2StorageGate, probeV2StorageAtBoot } from "../v2/hooks/storage-gate";
import {
    __resetRpcIdentityTestHooks,
    __setAsyncProcessProbeForTests,
    __setRpcIdentityTestHooks,
    inspectProcessesAsync,
} from "./rpc-utils";
import { Database } from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

afterEach(() => {
    __resetSchemaFenceStateForTests();
    __resetRpcIdentityTestHooks();
    __setAsyncProcessProbeForTests();
});

test("async Windows inspection bypasses slow synchronous probes and shares a bounded snapshot", async () => {
    let synchronousCalls = 0;
    const slow = (() => {
        synchronousCalls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
        return "";
    }) as typeof execFileSync;
    __setRpcIdentityTestHooks({
        platform: "win32",
        execFileSync: slow,
        processListExecFileSync: slow,
    });
    let release!: (value: string) => void;
    let calls = 0;
    __setAsyncProcessProbeForTests(async (file, _args, timeout) => {
        expect(file).toBe("powershell");
        expect(timeout).toBe(5000);
        calls++;
        return new Promise<string>((resolve) => {
            release = resolve;
        });
    });
    const first = inspectProcessesAsync();
    const second = inspectProcessesAsync();
    expect(second).toBe(first);
    const heartbeat = await Promise.race([
        first.then(() => "probe"),
        new Promise<string>((resolve) => setTimeout(() => resolve("heartbeat"), 10)),
    ]);
    expect(heartbeat).toBe("heartbeat");
    release(
        JSON.stringify([
            {
                ProcessId: 12345,
                ParentProcessId: 1,
                CommandLine: "opencode serve",
                CreationDate: "2026-09-28T00:00:00Z",
            },
        ]),
    );
    const result = await first;
    expect(result.liveness(12345)).toBe("alive");
    expect(result.evidence(12345).commandLine).toBe("opencode serve");
    expect(result.liveness(12346)).toBe("dead");
    expect(await inspectProcessesAsync()).toBe(result);
    expect(calls).toBe(1);
    expect(synchronousCalls).toBe(0);
});

test("offline process inspection can bypass a cached snapshot", async () => {
    __setRpcIdentityTestHooks({ platform: "win32" });
    let calls = 0;
    __setAsyncProcessProbeForTests(async () => {
        calls++;
        return JSON.stringify([
            {
                ProcessId: calls + 100,
                ParentProcessId: 1,
                Name: "opencode.exe",
                CommandLine: null,
                CreationDate: "2026-09-28T00:00:00Z",
            },
        ]);
    });
    const cached = await inspectProcessesAsync();
    expect((await inspectProcessesAsync()).processSnapshot).toBe(cached.processSnapshot);
    const fresh = await inspectProcessesAsync(true);
    expect(fresh.processSnapshot?.source).toBe("cim");
    expect(fresh.processSnapshot?.facts).toContainEqual(
        expect.objectContaining({ pid: 102, imageName: "opencode.exe", commandLine: null }),
    );
    expect(calls).toBe(2);
});

test("async Windows inspection bounds CIM and tasklist fallback and caches failure", async () => {
    __setRpcIdentityTestHooks({ platform: "win32" });
    const calls: Array<[string, number]> = [];
    __setAsyncProcessProbeForTests(async (file, _args, timeout) => {
        calls.push([file, timeout]);
        throw new Error("probe timed out");
    });
    const result = await inspectProcessesAsync();
    expect(result.pi.state).toBe("unreadable");
    expect(result.liveness(123)).toBe("inconclusive");
    expect(result.evidence(123)).toEqual({ startTime: null, commandLine: null });
    await inspectProcessesAsync();
    expect(calls).toEqual([
        ["powershell", 5000],
        ["tasklist", 1000],
    ]);
});

test("boot storage wait stays responsive with a locked v90 store and slow Windows probes", async () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "async-storage-guard-"));
    const dbPath = join(root, "context.db");
    const seeded = new Database(dbPath);
    seeded.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(90)",
    );
    seeded.exec("BEGIN IMMEDIATE");
    mkdirSync(join(root, "rpc", "blocker"), { recursive: true });
    writeFileSync(
        join(root, "rpc", "blocker", "port-12345.json"),
        JSON.stringify({
            pid: 12345,
            port: 43123,
            started_at: Date.now(),
            kind: "OpenCode server",
        }),
    );
    let syncCalls = 0;
    const slow = (() => {
        syncCalls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
        return "";
    }) as typeof execFileSync;
    __setRpcIdentityTestHooks({
        platform: "win32",
        execFileSync: slow,
        processListExecFileSync: slow,
    });
    let release!: (value: string) => void;
    __setAsyncProcessProbeForTests(
        () =>
            new Promise<string>((resolve) => {
                release = resolve;
            }),
    );
    try {
        const gate = createV2StorageGate({
            open: () => openDatabaseAsync({ dbPath, busyTimeoutMs: 0 }),
        });
        const started = performance.now();
        const boot = probeV2StorageAtBoot(gate);
        const opening = gate.probe();
        expect(
            await Promise.race([
                opening.then(() => "opened"),
                new Promise<string>((resolve) => setTimeout(() => resolve("responsive"), 10)),
            ]),
        ).toBe("responsive");
        expect(performance.now() - started).toBeLessThan(300);
        expect(gate.current()).toBeUndefined();
        release(
            JSON.stringify([
                {
                    ProcessId: 12345,
                    ParentProcessId: 1,
                    CommandLine: "opencode serve",
                    CreationDate: "2026-01-01T00:00:00Z",
                },
            ]),
        );
        expect(await opening).toBeUndefined();
        expect(await boot).toBeUndefined();
        expect(gate.reason()?.kind).toBe("migration_guard");
        expect(getMigrationOnOpenRefusal()?.serverPids).toEqual([12345]);
        expect(syncCalls).toBe(0);
        const checked = new Database(dbPath);
        expect(
            checked.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
        ).toEqual({ version: 90 });
        checked.close();
    } finally {
        seeded.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("Windows PowerShell 5.1 wrapped creation dates still prove a holder's identity", async () => {
    __setRpcIdentityTestHooks({ platform: "win32" });
    __setAsyncProcessProbeForTests(async () =>
        JSON.stringify([
            {
                ProcessId: 10376,
                ParentProcessId: 1,
                Name: "opencode.exe",
                CommandLine: "opencode.exe",
                CreationDate: {
                    value: "/Date(1790763300123)/",
                    DisplayHint: 2,
                    DateTime: "Wednesday, September 30, 2026 12:15:00 PM",
                },
            },
            {
                ProcessId: 10377,
                ParentProcessId: 1,
                Name: "opencode.exe",
                CommandLine: "opencode.exe",
                CreationDate: "2026-09-30T10:15:00.1234567Z",
            },
        ]),
    );
    const result = await inspectProcessesAsync();
    expect(result.evidence(10376).startTime).toBe(1790763300123);
    expect(result.evidence(10377).startTime).toBe(1790763300123);
});

test("a timed-out refresh retains confirmed blockers until a successful process scan", async () => {
    let now = 1000;
    __setRpcIdentityTestHooks({ platform: "win32", nowMs: () => now });
    let fail = false;
    let calls = 0;
    let pid = 12345;
    __setAsyncProcessProbeForTests(async () => {
        calls++;
        if (fail) throw new Error("timeout");
        return JSON.stringify([
            {
                ProcessId: pid,
                ParentProcessId: 1,
                CommandLine: "opencode serve",
                CreationDate: "2026-01-01T00:00:00Z",
            },
        ]);
    });
    const first = await inspectProcessesAsync();
    now += 1999;
    expect(await inspectProcessesAsync()).toBe(first);
    expect(calls).toBe(1);
    now++;
    fail = true;
    const failed = await inspectProcessesAsync();
    expect(calls).toBe(3);
    expect(failed.liveness(12345)).toBe("alive");
    expect(failed.liveness(54321)).toBe("inconclusive");
    expect(failed.evidence(12345)).toEqual(first.evidence(12345));
    now += 2000;
    fail = false;
    pid = 54321;
    const refreshed = await inspectProcessesAsync();
    expect(calls).toBe(4);
    expect(refreshed.liveness(12345)).toBe("dead");
});
