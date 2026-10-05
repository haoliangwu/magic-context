/// <reference types="bun-types" />

/**
 * Which process may read OpenCode's session store, and how much of it.
 *
 * A Pi process shares Magic Context's context.db with OpenCode, so stored rows
 * (primer candidates, tags, message-index rows) name OpenCode sessions from any
 * project. Any history read for a session with no Pi provider used to fall
 * through to opencode.db and materialise the whole session: every message and
 * every JSON-parsed part, tool outputs and LSP diagnostics included. These
 * tests pin that a Pi process never opens OpenCode's store, that a primer seed
 * never reads a session of another project, and that the seed read stays
 * bounded whatever the session size.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import { buildPrimerSeed } from "../../features/magic-context/dreamer/primer-seed";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    createPrimer,
    getActivePrimers,
    insertPrimerCandidates,
} from "../../features/magic-context/storage-primers";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { writeOpenCodeV1FixtureStore } from "./opencode-v1-store-fixture";
import {
    readRawSessionMessagePage,
    readRawSessionMessages,
    visitRawSessionMessages,
} from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";

const originalOpenCodeDb = process.env.OPENCODE_DB;
let tempDir = "";

function useFixtureStore(sessions: Parameters<typeof writeOpenCodeV1FixtureStore>[1]): void {
    const dbPath = join(tempDir, "opencode", "opencode.db");
    writeOpenCodeV1FixtureStore(dbPath, sessions);
    process.env.OPENCODE_DB = dbPath;
    resetOpenCodeDbPathStateForTesting();
    closeReadOnlySessionDb();
}

beforeEach(() => {
    tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-opencode-store-scope-"));
});

afterEach(() => {
    closeReadOnlySessionDb();
    _resetHarnessForTesting();
    if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpenCodeDb;
    resetOpenCodeDbPathStateForTesting();
    rmSync(tempDir, { recursive: true, force: true });
});

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("OpenCode store access by harness", () => {
    it("an OpenCode process reads a stored OpenCode session (fixture control)", () => {
        useFixtureStore([{ sessionId: "ses_other_project", turns: 3 }]);
        expect(readRawSessionMessages("ses_other_project")).toHaveLength(6);
    });

    it("a Pi process never reads OpenCode's store for a session with no Pi provider", () => {
        useFixtureStore([{ sessionId: "ses_other_project", turns: 3 }]);
        setHarness("pi");
        expect(readRawSessionMessages("ses_other_project")).toEqual([]);
        expect(readRawSessionMessagePage("ses_other_project", 0, 10, 10)).toEqual([]);
        const visited: number[] = [];
        visitRawSessionMessages("ses_other_project", 1, 6, (message) => {
            visited.push(message.ordinal);
            return true;
        });
        expect(visited).toEqual([]);
        expect(openOpenCodeDb()).toBeNull();
    });
});

describe("primer seed session selection", () => {
    function seedPrimer(
        db: Database,
        candidates: Array<{ projectPath: string; sessionId: string; time: number }>,
    ) {
        const ids = insertPrimerCandidates(
            db,
            candidates.map((candidate) => ({
                projectPath: candidate.projectPath,
                harness: "opencode",
                sessionId: candidate.sessionId,
                question: "How is the cache invalidated?",
                sourceCompartmentStart: 1,
                sourceCompartmentEnd: 4,
                sourceStartMessageId: `${candidate.sessionId}-u000001`,
                sourceEndMessageId: `${candidate.sessionId}-a000002`,
                sourceMessageTime: candidate.time,
            })),
        );
        createPrimer(db, {
            projectPath: "git:project-a",
            question: "How is the cache invalidated?",
            totalSupport: ids.length,
            lastObservedAt: 10,
            sourceCandidateIds: ids,
        });
        const [primer] = getActivePrimers(db, "git:project-a");
        if (!primer) throw new Error("primer fixture missing");
        return primer;
    }

    it("never seeds from a candidate recorded under another project", () => {
        useFixtureStore([
            { sessionId: "ses_project_a", turns: 2 },
            { sessionId: "ses_project_b", turns: 2 },
        ]);
        const db = contextDb();
        const primer = seedPrimer(db, [
            { projectPath: "git:project-a", sessionId: "ses_project_a", time: 1 },
            // Newer, so it would win the most-recent pick if projects were ignored.
            { projectPath: "git:project-b", sessionId: "ses_project_b", time: 2 },
        ]);
        const seed = buildPrimerSeed(db, primer);
        expect(seed.sessionId).toBe("ses_project_a");
        expect(seed.kind).toBe("raw");
        expect(seed.orientation).toContain("U: question 1");
        expect(seed.orientation).toContain("TC: read(/src/File1.kt)");
    });

    it("a Pi process seeds an OpenCode-origin primer closed-book instead of reading opencode.db", () => {
        useFixtureStore([{ sessionId: "ses_project_a", turns: 2 }]);
        const db = contextDb();
        const primer = seedPrimer(db, [
            { projectPath: "git:project-a", sessionId: "ses_project_a", time: 1 },
        ]);
        setHarness("pi");
        const seed = buildPrimerSeed(db, primer);
        expect(seed.kind).toBe("closed-book");
        expect(seed.orientation).not.toContain("question 1");
    });
});

describe("bounded summary reads", () => {
    it("the summary projection drops tool outputs and diagnostics but keeps U:/TC: inputs", () => {
        useFixtureStore([
            {
                sessionId: "ses_big_parts",
                turns: 2,
                toolOutputChars: 50_000,
                diagnosticsPerTool: 50,
            },
        ]);
        const messages: Array<{ ordinal: number; parts: unknown[] }> = [];
        visitRawSessionMessages(
            "ses_big_parts",
            1,
            4,
            (message) => {
                messages.push(message);
                return true;
            },
            { summary: true, pageSize: 3 },
        );
        expect(messages.map((message) => message.ordinal)).toEqual([1, 2, 3, 4]);
        const serialized = JSON.stringify(messages);
        expect(serialized).not.toContain("xxxxxxxxxx");
        expect(serialized).not.toContain("Unresolved reference");
        expect(serialized).toContain("/src/File1.kt");
        expect(serialized).toContain("question 2");
        expect(serialized.length).toBeLessThan(4_000);
    });

    it("keeps peak heap flat on a large session while the full reader does not", () => {
        const turns = 2_000;
        useFixtureStore([
            {
                sessionId: "ses_large",
                turns,
                toolOutputChars: 16_000,
                diagnosticsPerTool: 40,
            },
        ]);
        // Other test files leave allocations and GC activity in the runner's
        // heap. Measure both real readers in a fresh process, not that heap.
        const child = spawnSync(
            process.execPath,
            [
                fileURLToPath(
                    new URL("../../../scripts/fixtures/summary-read-heap.ts", import.meta.url),
                ),
                join(tempDir, "opencode", "opencode.db"),
                String(turns),
            ],
            { encoding: "utf8", windowsHide: true, timeout: 25_000 },
        );
        if (child.error || child.status !== 0) {
            throw new Error(
                `Heap measurement child failed (status=${child.status}): ${child.stderr}`,
                {
                    cause: child.error,
                },
            );
        }
        const { visited, fullCount, visitDelta, fullDelta } = JSON.parse(child.stdout) as {
            visited: number;
            fullCount: number;
            visitDelta: number;
            fullDelta: number;
        };
        expect(visited).toBe(turns * 2);
        expect(fullCount).toBe(turns * 2);

        console.log(
            `[heap] session=${turns * 2} messages: full read +${(fullDelta / 2 ** 20).toFixed(1)} MiB, ` +
                `streamed summary read peak +${(visitDelta / 2 ** 20).toFixed(1)} MiB`,
        );
        expect(fullDelta).toBeGreaterThan(20 * 2 ** 20);
        expect(visitDelta).toBeLessThan(8 * 2 ** 20);
    });
});
