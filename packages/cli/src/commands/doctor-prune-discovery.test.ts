import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { inspectRpcServerDiscovery } from "@magic-context/core/features/magic-context/storage-db";
import type { AsyncProcessInspection } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { runMergeIdentityCli } from "./doctor-merge-identity";
import {
    PRUNE_DISCOVERY_COMMAND,
    reportDiscoveryRecords,
    runDiscoveryDoctorCheck,
    runPruneDiscoveryCli,
} from "./doctor-prune-discovery";
import { defaultInspectHolders } from "./doctor-repair-db";

const tempDirs: string[] = [];
const savedEnv = {
    storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    xdg: process.env.XDG_DATA_HOME,
};

function tempDir(): string {
    const path = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-prune-discovery-")));
    tempDirs.push(path);
    return path;
}

let storage = "";

beforeEach(() => {
    // Throwaway storage and XDG roots: nothing here may reach a real rpc/ tree.
    const root = tempDir();
    storage = join(root, "cortexkit", "magic-context");
    mkdirSync(storage, { recursive: true });
    process.env.XDG_DATA_HOME = root;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = storage;
});

afterEach(() => {
    if (savedEnv.storage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = savedEnv.storage;
    if (savedEnv.xdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedEnv.xdg;
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface FakeProcess {
    startTime: number | null;
    imageName: string;
}

/** A Windows CIM process snapshot: listed PIDs are alive, every other PID is dead. */
function cimProcesses(byPid: Map<number, FakeProcess>): AsyncProcessInspection {
    return {
        pi: { state: "known", processIds: [] },
        processSnapshot: {
            source: "cim",
            facts: [...byPid].map(([pid, fact]) => ({
                pid,
                imageName: fact.imageName,
                commandLine: null,
            })),
        },
        liveness: (pid) => (byPid.has(pid) ? "alive" : "dead"),
        evidence: (pid) => {
            const fact = byPid.get(pid);
            return {
                startTime: fact?.startTime ?? null,
                commandLine: fact?.imageName ?? null,
                ...(fact ? { imageName: fact.imageName } : {}),
            };
        },
    };
}

function writeRecord(project: string, name: string, record: Record<string, unknown>): string {
    const dir = join(storage, "rpc", project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(record));
    return file;
}

function listRecords(): string[] {
    const rpc = join(storage, "rpc");
    if (!existsSync(rpc)) return [];
    return readdirSync(rpc)
        .flatMap((project) => readdirSync(join(rpc, project)).map((name) => `${project}/${name}`))
        .sort();
}

const at = (iso: string) => Date.parse(iso);

/** Backdate every discovery project directory by an hour, past the pruning age limit. */
function ageRpcDirs(): void {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const rpc = join(storage, "rpc");
    for (const name of readdirSync(rpc)) utimesSync(join(rpc, name), hourAgo, hourAgo);
}
const HOST_PID = 13620;
const HOST_DIR = "60beaf10494f9d58";

/**
 * The discovery tree reported on a Windows machine: ten records of a running
 * OpenCode server, twenty-one records whose PIDs Windows had since given to
 * unrelated processes (twenty in the older format without kind or instance_id),
 * and forty-six empty project directories.
 */
function seedIssueTree(): { genuine: string[]; processes: Map<number, FakeProcess> } {
    const processes = new Map<number, FakeProcess>();
    const genuine: string[] = [];
    processes.set(HOST_PID, {
        startTime: at("2026-10-01T13:35:28Z"),
        imageName: "opencode.exe",
    });
    for (let index = 0; index < 10; index++) {
        const instance = `d03836ad5843${String(index).padStart(4, "0")}`;
        genuine.push(
            writeRecord(HOST_DIR, `port-${HOST_PID}-${instance}.json`, {
                port: 60540 + index,
                pid: HOST_PID,
                started_at: 1790861741858 + index * 100,
                kind: "OpenCode server",
                token: "t",
                instance_id: instance,
            }),
        );
    }

    // Reused PIDs whose new process start is readable and later than the record.
    const laterStart: Array<[number, string, string, string]> = [
        [15520, "2026-08-16T22:49:55Z", "2026-09-28T16:53:00Z", "LinuxFS.exe"],
        [17268, "2026-06-27T14:11:00Z", "2026-09-28T16:53:00Z", "Microsoft.CmdPal.UI.exe"],
        [17484, "2026-07-13T14:50:54Z", "2026-09-28T18:47:00Z", "RuntimeBroker.exe"],
        [17856, "2026-07-22T02:56:22Z", "2026-09-29T11:14:00Z", "Cherry Studio.exe"],
        [19412, "2026-08-09T22:42:00Z", "2026-09-28T16:53:00Z", "PowerToys.PowerOCR.exe"],
        [26532, "2026-06-25T19:18:00Z", "2026-09-28T16:54:00Z", "dllhost.exe"],
        [28120, "2026-07-02T18:31:00Z", "2026-09-28T16:53:00Z", "VCTray.exe"],
    ];
    // The start time alone proves reuse, even when the new process is a runtime.
    for (let index = 0; index < 11; index++) {
        laterStart.push([
            30001 + index,
            "2026-07-01T10:00:00Z",
            "2026-09-28T17:00:00Z",
            index % 2 === 0 ? "node.exe" : "explorer.exe",
        ]);
    }
    for (const [pid, recorded, actual, imageName] of laterStart) {
        processes.set(pid, { startTime: at(actual), imageName });
        const project = [15520, 17484, 17856].includes(pid) ? HOST_DIR : `p${pid}`;
        writeRecord(project, `port-${pid}.json`, {
            port: 54209,
            pid,
            started_at: at(recorded),
            token: "t",
        });
    }

    // Reused PIDs whose start time cannot be read, held by images no host runs.
    processes.set(3128, { startTime: null, imageName: "svchost.exe" });
    writeRecord(HOST_DIR, "port-3128.json", {
        port: 49946,
        pid: 3128,
        started_at: 1784685042027,
        token: "t",
    });
    processes.set(7036, { startTime: null, imageName: "svchost.exe" });
    writeRecord("p7036", "port-7036.json", {
        port: 49947,
        pid: 7036,
        started_at: at("2026-07-12T14:28:00Z"),
        token: "t",
    });
    processes.set(40292, { startTime: null, imageName: "WinAutomation.UserAgent.exe" });
    writeRecord("p40292", "port-40292-aa11bb22cc33dd44.json", {
        port: 49948,
        pid: 40292,
        started_at: at("2026-09-03T19:22:00Z"),
        kind: "OpenCode server",
        token: "t",
        instance_id: "aa11bb22cc33dd44",
    });

    for (let index = 0; index < 46; index++) {
        mkdirSync(join(storage, "rpc", `empty${index}`), { recursive: true });
    }
    return { genuine, processes };
}

function createMergeFixture(): { dbPath: string; args: string[] } {
    const dbPath = join(storage, "context.db");
    const db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("INSERT INTO project_state(project_path) VALUES ('dir:source'), ('git:target')");
    db.close();
    return {
        dbPath,
        args: ["--db", dbPath, "--from", "dir:source", "--to", "git:target", "--force", "--apply"],
    };
}

function holdersWith(processes: Map<number, FakeProcess>) {
    return (storageDir: string) =>
        defaultInspectHolders(storageDir, {
            defaultStorageDir: storageDir,
            inspectRpc: (dir, _processes, options) =>
                inspectRpcServerDiscovery(dir, cimProcesses(processes), options),
            inspectPi: () => ({ state: "known", processIds: [] }),
        });
}

function fileHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("doctor merge-identities with reused PIDs in discovery records", () => {
    it("removes the 21 reused-PID records, keeps the live host blocking, then allows the merge once it exits", async () => {
        const { genuine, processes } = seedIssueTree();
        const { dbPath, args } = createMergeFixture();
        const before = fileHash(dbPath);
        expect(listRecords()).toHaveLength(31);

        // The OpenCode server is still running: its records stay and it blocks the
        // merge by name, with no undetermined liveness left in the refusal.
        let refusal = "";
        try {
            runMergeIdentityCli(args, {
                inspectHolders: holdersWith(processes),
                probe: () => ({ status: "free" }),
            });
        } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
        }
        expect(refusal).toContain(`OpenCode server (PID ${HOST_PID})`);
        expect(refusal).not.toContain("could not be determined");
        expect(listRecords()).toEqual(
            genuine.map((file) => `${HOST_DIR}/${file.split(/[\\/]/).at(-1)}`).sort(),
        );
        // The merge's holder check never removes directories: 46 empty ones plus
        // the 17 it just emptied are still there.
        expect(readdirSync(join(storage, "rpc"))).toHaveLength(64);
        expect(fileHash(dbPath)).toBe(before);

        // `doctor --prune-discovery` removes empty directories older than a minute
        // and leaves a fresh one, which a starting host may be about to fill.
        ageRpcDirs();
        mkdirSync(join(storage, "rpc", "fresh"));
        expect(
            await runPruneDiscoveryCli(["--yes"], {
                storageDir: storage,
                inspect: (dir) => inspectRpcServerDiscovery(dir, cimProcesses(processes)),
                interactive: false,
                print: () => {},
            }),
        ).toBe(0);
        expect(readdirSync(join(storage, "rpc")).sort()).toEqual([HOST_DIR, "fresh"]);
        expect(listRecords()).toHaveLength(10);

        // The server exits: its PID is dead, so its records are stale too.
        processes.delete(HOST_PID);
        expect(
            runMergeIdentityCli(args, {
                inspectHolders: holdersWith(processes),
                probe: () => ({ status: "free" }),
            }),
        ).toBe(0);
        expect(listRecords()).toEqual([]);
    }, 30_000);
});

describe("doctor --prune-discovery", () => {
    function seedUnresolved(): { file: string; processes: Map<number, FakeProcess> } {
        const processes = new Map<number, FakeProcess>([
            [7036, { startTime: null, imageName: "node.exe" }],
        ]);
        const file = writeRecord("p", "port-7036.json", {
            port: 49947,
            pid: 7036,
            started_at: at("2026-07-12T14:28:00Z"),
        });
        return { file, processes };
    }

    it("names itself in the merge refusal when liveness cannot be determined", () => {
        const { processes } = seedUnresolved();
        const { args } = createMergeFixture();
        expect(() =>
            runMergeIdentityCli(args, {
                inspectHolders: holdersWith(processes),
                probe: () => ({ status: "free" }),
            }),
        ).toThrow(PRUNE_DISCOVERY_COMMAND);
    }, 30_000);

    it("lists unresolved records with their evidence and removes them only after confirmation", async () => {
        const { file, processes } = seedUnresolved();
        const lines: string[] = [];
        const deps = {
            storageDir: storage,
            inspect: (dir: string) => inspectRpcServerDiscovery(dir, cimProcesses(processes)),
            print: (line: string) => lines.push(line),
        };

        expect(await runPruneDiscoveryCli([], { ...deps, interactive: false })).toBe(1);
        expect(existsSync(file)).toBe(true);
        const evidence = lines.find((line) => line.includes("PID 7036"));
        expect(evidence).toContain("recorded start 2026-07-12T14:28:00.000Z");
        expect(evidence).toContain("actual start unreadable");
        expect(evidence).toContain("image node.exe");

        expect(
            await runPruneDiscoveryCli([], {
                ...deps,
                interactive: true,
                confirm: async () => false,
            }),
        ).toBe(1);
        expect(existsSync(file)).toBe(true);

        expect(
            await runPruneDiscoveryCli([], {
                ...deps,
                interactive: true,
                confirm: async () => true,
            }),
        ).toBe(0);
        expect(existsSync(file)).toBe(false);
        // Its directory was emptied just now, so the age rule keeps it until a later run.
        expect(existsSync(join(storage, "rpc", "p"))).toBe(true);
    });

    it("removes unresolved records without a prompt when --yes is passed", async () => {
        const { file, processes } = seedUnresolved();
        expect(
            await runPruneDiscoveryCli(["--prune-discovery", "--yes"], {
                storageDir: storage,
                inspect: (dir) => inspectRpcServerDiscovery(dir, cimProcesses(processes)),
                interactive: false,
                confirm: async () => {
                    throw new Error("--yes must not prompt");
                },
                print: () => {},
            }),
        ).toBe(0);
        expect(existsSync(file)).toBe(false);
    });

    it("doctor reports unresolved records as an issue instead of passing", () => {
        const { processes } = seedUnresolved();
        const warnings: string[] = [];
        const passes: string[] = [];
        const issue = reportDiscoveryRecords(
            inspectRpcServerDiscovery(storage, cimProcesses(processes)),
            {
                pass: (message) => passes.push(message),
                warn: (message) => warnings.push(message),
                info: () => {},
            },
        );
        expect(issue).toBe(true);
        expect(passes).toEqual([]);
        expect(warnings.join("\n")).toContain(PRUNE_DISCOVERY_COMMAND);
    });

    it("doctor removes old empty discovery directories only with --fix", () => {
        mkdirSync(join(storage, "rpc", "old-empty"), { recursive: true });
        ageRpcDirs();
        mkdirSync(join(storage, "rpc", "fresh-empty"));
        const sink = { pass: () => {}, warn: () => {}, info: () => {} };
        const inspect = (dir: string) => inspectRpcServerDiscovery(dir, cimProcesses(new Map()));

        expect(runDiscoveryDoctorCheck(storage, { inspect }, sink)).toBe(false);
        expect(existsSync(join(storage, "rpc", "old-empty"))).toBe(true);

        expect(runDiscoveryDoctorCheck(storage, { fix: true, inspect }, sink)).toBe(false);
        expect(existsSync(join(storage, "rpc", "old-empty"))).toBe(false);
        expect(existsSync(join(storage, "rpc", "fresh-empty"))).toBe(true);
    });
});
