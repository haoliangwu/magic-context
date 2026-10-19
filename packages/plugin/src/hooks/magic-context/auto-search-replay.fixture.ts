import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, type HarnessId, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { _resetAutoSearchCache } from "./auto-search-runner";
import { clearInjectionCache, type M0M1RenderOptions } from "./inject-compartments";

export const replayPrompt = "Explain cache ownership";
export const replayScenarios = ["defer", "revert", "model fold", "reopen"] as const;
export const replayHint = {
    source: "memory" as const,
    content: "Independent search-only hint",
    score: 0.95,
    memoryId: 9000,
    category: "ARCHITECTURE",
    matchType: "fts" as const,
};

/** A real disk database lets replay tests discard process caches and reopen storage. */
export function createAutoSearchReplayFixture(
    host: HarnessId,
    label: string,
): {
    readonly db: Database;
    sessionId: string;
    projectPath: string;
    directory: string;
    renderOptions(modelKey?: string): M0M1RenderOptions;
    reopen(preserveProcessState?: boolean): void;
    close(): void;
} {
    _resetHarnessForTesting();
    setHarness(host);
    const directory = createTestTempDirFromPath(join(tmpdir(), "auto-search-replay-"));
    const databasePath = join(directory, "context.db");
    const sessionId = `${host}-auto-search-${label}`;
    const projectPath = "git:auto-search-replay";
    let db = new Database(databasePath);
    initializeDatabase(db);
    runMigrations(db);
    insertMemory(db, {
        projectPath,
        category: "ARCHITECTURE",
        content: "Pair baseline distinct from hint.",
        importance: 50,
    });
    return {
        get db() {
            return db;
        },
        sessionId,
        projectPath,
        directory,
        renderOptions(modelKey = "anthropic/claude") {
            return {
                db,
                state: getOrCreateSessionMeta(db, sessionId),
                sessionId,
                projectPath,
                projectDirectory: directory,
                injectDocs: false,
                memoryInjectionBudgetTokens: 8000,
                historyBudgetTokens: 60000,
                hardSignals: {
                    systemHash: "system",
                    modelKey,
                    cacheExpired: false,
                    lastResponseTime: 1,
                },
            };
        },
        reopen(preserveProcessState = false) {
            db.close();
            clearInjectionCache(sessionId);
            // Reopening a handle is not a process restart; failed-save omissions
            // must survive it when the caller keeps this process's state alive.
            if (!preserveProcessState) _resetAutoSearchCache();
            db = new Database(databasePath);
        },
        close() {
            clearInjectionCache(sessionId);
            _resetAutoSearchCache();
            db.close();
            cleanupTestTempDir(directory);
            _resetHarnessForTesting();
        },
    };
}
