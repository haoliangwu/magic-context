import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { SubcModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { promptIO } from "../lib/prompts";

import {
    applyMigrateSession,
    assertMigrateSessionIsSafeToRehome,
    type MigrateSessionDeps,
    type MigrateSessionSafetyModule,
    planMigrateSession,
    runMigrateSessionCli,
} from "./migrate-session";

const databases: Array<{ close(): void }> = [];

afterEach(() => {
    for (const db of databases) {
        try {
            db.close();
        } catch {
            /* ignore */
        }
    }
    databases.length = 0;
});

function makeOpencodeDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            directory TEXT,
            path TEXT,
            workspace_id TEXT,
            title TEXT
        );
        CREATE TABLE project (
            id TEXT PRIMARY KEY,
            worktree TEXT NOT NULL
        );
    `);
    db.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
    return db;
}

function makeContextDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            importance INTEGER,
            source_session_id TEXT,
            source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            created_at INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_path, category, normalized_hash)
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id TEXT
        );
        CREATE TABLE session_projects (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, harness)
        );
        CREATE TABLE compartment_chunk_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project_path TEXT NOT NULL
        );
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            cached_m0_bytes BLOB,
            cached_m1_bytes BLOB
        );
        CREATE TABLE project_state (
            project_path TEXT PRIMARY KEY,
            project_memory_epoch INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE single_store_state (id INTEGER PRIMARY KEY, state TEXT NOT NULL);
        INSERT INTO single_store_state VALUES (1, 'required');
        CREATE TABLE authority_managed (
            project_path TEXT PRIMARY KEY,
            context_store_uuid TEXT NOT NULL,
            marked_at INTEGER NOT NULL
        );
    `);
    return db;
}

let hashCounter = 0;
function insertMemory(
    db: Database,
    projectPath: string,
    sourceSessionId: string | null,
    opts: { status?: string; category?: string; content?: string; withEmbedding?: boolean } = {},
): number {
    const content = opts.content ?? `memory-${++hashCounter}`;
    const hash = `hash-${hashCounter}`;
    const res = db
        .prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, source_type, seen_count, status, created_at)
             VALUES (?, ?, ?, ?, 50, ?, 'historian', 1, ?, 0)`,
        )
        .run(
            projectPath,
            opts.category ?? "ARCHITECTURE",
            content,
            hash,
            sourceSessionId,
            opts.status ?? "active",
        ) as { lastInsertRowid: number | bigint };
    const id = Number(res.lastInsertRowid);
    if (opts.withEmbedding) {
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
        ).run(id, new Uint8Array([1, 2, 3]));
    }
    return id;
}

const FROM = "git:from";
const TO = "git:to";
const SID = "ses_test";
const OTHER_SID = "ses_other";

function seedSession(oc: Database, ctx: Database): void {
    oc.prepare(
        "INSERT INTO session (id, project_id, directory, path) VALUES (?, 'global', '/old/dir', 'old/dir')",
    ).run(SID);
    ctx.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare("INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?)").run(
        SID,
        new Uint8Array([9]),
    );
}

function makeDeps(oc: Database, ctx: Database, targetIsGit = true): MigrateSessionDeps {
    return {
        opencodeDb: oc,
        contextDb: ctx,
        resolveIdentity: (dir) => (dir.includes("benchmarks") ? TO : FROM),
        hasGitDir: () => targetIsGit,
        realpath: (p) => p,
        now: 1000,
    };
}

function installAuthorityMarker(ctx: Database, projectPath: string): void {
    ctx.prepare(
        "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store-test', 0)",
    ).run(projectPath);
}

function makeSafetyModule(opts: { sessionStatus?: unknown | Error } = {}): {
    module: MigrateSessionSafetyModule;
    sessionCalls: Array<{ sessionId: string; projectRoot: string }>;
} {
    const sessionCalls: Array<{ sessionId: string; projectRoot: string }> = [];
    return {
        module: {
            async sessionStatus(args) {
                sessionCalls.push(args);
                if (opts.sessionStatus instanceof Error) throw opts.sessionStatus;
                return opts.sessionStatus ?? { row_version: null };
            },
        },
        sessionCalls,
    };
}

describe("planMigrateSession", () => {
    it("resolves a git target to its existing project row", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID);

        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("proj_bench");
        expect(plan.ocWorktree).toBe("/home/u/benchmarks");
        expect(plan.ocProjectResolvedFromRow).toBe(true);
        expect(plan.sessionPath).toBe(""); // relative(worktree, dir) when equal
        expect(plan.fromMcIdentity).toBe(FROM);
        expect(plan.toMcIdentity).toBe(TO);
        expect(plan.injectableMemoryCount).toBe(2);
        expect(plan.originatedMemoryCount).toBe(1);
    });

    it("falls back to global (with flag) when a git target has no registered project (empty repo)", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        // hasGitDir=true but no per-worktree project row → OpenCode would use
        // global (empty repo, no commit/remote). Must NOT dead-end.
        const plan = planMigrateSession(SID, "/home/u/unregistered", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.targetIsGit).toBe(true);
        expect(plan.ocProjectResolvedFromRow).toBe(false);
    });

    it("resolves a non-git target to the global project", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.ocWorktree).toBe("/");
        expect(plan.sessionPath).toBe("home/u/benchmarks");
        expect(plan.targetIsGit).toBe(false);
    });

    it("throws for an unknown session", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        expect(() => planMigrateSession("ses_nope", "/x", makeDeps(oc, ctx))).toThrow(/not found/);
    });
});

describe("assertMigrateSessionIsSafeToRehome", () => {
    function safetyPlan(ctx: Database): ReturnType<typeof planMigrateSession> {
        const oc = makeOpencodeDb();
        seedSession(oc, ctx);
        return planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
    }

    it("refuses unmigrated authority with MC-C14 before probing the module", async () => {
        for (const missing of [false, true]) {
            const ctx = makeContextDb();
            if (missing) ctx.exec("DROP TABLE single_store_state");
            installAuthorityMarker(ctx, "git:unrelated");
            const plan = safetyPlan(ctx);
            const { module, sessionCalls } = makeSafetyModule();
            await expect(
                assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
            ).rejects.toThrow("(MC-C14)");
            expect(sessionCalls).toHaveLength(0);
        }
    });

    it("warns but proceeds when session.status is unreachable and no markers exist", async () => {
        const ctx = makeContextDb();
        const plan = safetyPlan(ctx);
        const { module } = makeSafetyModule({ sessionStatus: new Error("subc offline") });

        const result = await assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module });
        expect(result.warnings).toEqual([
            expect.stringContaining("session-cache state was not checked"),
        ]);
    });

    it("refuses a session with module transform cache state without deleting it", async () => {
        const ctx = makeContextDb();
        const plan = safetyPlan(ctx);
        const { module, sessionCalls } = makeSafetyModule({ sessionStatus: { row_version: 7 } });

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).rejects.toThrow(/transform cache state.*TypeScript transform mode.*ck session delete/i);
        expect(sessionCalls).toEqual([{ sessionId: SID, projectRoot: "/old/dir" }]);
    });

    it("allows a migrated store to rehome a session", async () => {
        const ctx = makeContextDb();
        const oc = makeOpencodeDb();
        seedSession(oc, ctx);
        installAuthorityMarker(ctx, FROM);
        installAuthorityMarker(ctx, TO);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        ctx.exec("UPDATE single_store_state SET state='migrated'");
        const { module } = makeSafetyModule();

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).resolves.toEqual({
            warnings: [],
        });
        applyMigrateSession(plan, "leave", makeDeps(oc, ctx));
        expect(
            (
                ctx
                    .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
                    .get(SID) as { project_path: string }
            ).project_path,
        ).toBe(TO);
    });
});

describe("applyMigrateSession — OpenCode + context re-stamp", () => {
    it("updates the session row and re-stamps context.db, clearing cached m0/m1", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        const res = applyMigrateSession(plan, "leave", makeDeps(oc, ctx, true));

        const session = oc.prepare("SELECT * FROM session WHERE id = ?").get(SID) as {
            project_id: string;
            directory: string;
            path: string;
            workspace_id: string | null;
        };
        expect(session.project_id).toBe("proj_bench");
        expect(session.directory).toBe("/home/u/benchmarks");
        expect(session.workspace_id).toBeNull();

        const ownership = ctx
            .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
            .get(SID) as { project_path: string };
        expect(ownership.project_path).toBe(TO);
        expect(res.chunkEmbeddingsRestamped).toBe(2);
        const remainingOldChunks = (
            ctx
                .prepare(
                    "SELECT COUNT(*) AS c FROM compartment_chunk_embeddings WHERE session_id = ? AND project_path = ?",
                )
                .get(SID, FROM) as { c: number }
        ).c;
        expect(remainingOldChunks).toBe(0);
        const meta = ctx
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SID) as { cached_m0_bytes: unknown };
        expect(meta.cached_m0_bytes).toBeNull();
        // "leave" → no memory movement, no epoch bump.
        expect(res.epochsBumped).toEqual([]);
    });

    it("only updates session columns that exist (schema-resilient)", () => {
        const oc = new Database(":memory:");
        databases.push(oc);
        oc.exec(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);",
        );
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
        oc.prepare("INSERT INTO session (id, directory) VALUES (?, '/old')").run(SID);
        const ctx = makeContextDb();
        ctx.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run(SID, FROM);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        // Must not throw even though project_id/path/workspace_id columns are absent.
        applyMigrateSession(plan, "leave", makeDeps(oc, ctx, false));
        const row = oc.prepare("SELECT directory FROM session WHERE id = ?").get(SID) as {
            directory: string;
        };
        expect(row.directory).toBe("/home/u/benchmarks");
    });
});

describe("runMigrateSessionCli subc configuration", () => {
    it("constructs its transport with configured subc.connection_file", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-migrate-session-cli-"));
        const source = join(root, "source");
        const target = join(root, "target");
        const configHome = join(root, "config");
        const testDataDir = join(root, "data");
        const opencodeDbPath = join(root, "opencode.db");
        const configuredConnectionFile = join(root, "configured-subc.json");
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const originalDataHome = process.env.XDG_DATA_HOME;
        const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        const originalOpencodeDb = process.env.OPENCODE_DB;
        const connectionFiles: string[] = [];
        const callSpy = spyOn(SubcModuleTransport.prototype, "call").mockImplementation(
            async function () {
                connectionFiles.push(
                    (this as unknown as { connectionFile: string }).connectionFile,
                );
                return { row_version: null };
            },
        );
        try {
            mkdirSync(source, { recursive: true });
            mkdirSync(target, { recursive: true });
            mkdirSync(join(configHome, "cortexkit"), { recursive: true });
            writeFileSync(
                join(configHome, "cortexkit", "magic-context.jsonc"),
                JSON.stringify({ subc: { connection_file: configuredConnectionFile } }),
            );
            process.env.XDG_CONFIG_HOME = configHome;
            process.env.XDG_DATA_HOME = testDataDir;
            process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
            process.env.OPENCODE_DB = opencodeDbPath;

            const opencodeDb = new Database(opencodeDbPath);
            opencodeDb.exec(`
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    directory TEXT,
                    path TEXT,
                    workspace_id TEXT,
                    title TEXT
                );
                CREATE TABLE project (
                    id TEXT PRIMARY KEY,
                    worktree TEXT NOT NULL
                );
                INSERT INTO project (id, worktree) VALUES ('global', '/');
            `);
            opencodeDb
                .prepare("INSERT INTO session (id, project_id, directory) VALUES (?, 'global', ?)")
                .run(SID, source);
            opencodeDb.close();

            const contextDbPath = join(testDataDir, "cortexkit", "magic-context", "context.db");
            mkdirSync(join(testDataDir, "cortexkit", "magic-context"), { recursive: true });
            const contextDb = new Database(contextDbPath);
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            contextDb.close();

            expect(
                await runMigrateSessionCli([
                    "--session",
                    SID,
                    "--to",
                    target,
                    "--memories",
                    "leave",
                    "--dry-run",
                ]),
            ).toBe(0);
            expect(connectionFiles).toEqual([configuredConnectionFile]);
        } finally {
            callSpy.mockRestore();
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = originalDataHome;
            if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
            if (originalOpencodeDb === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = originalOpencodeDb;
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("applyMigrateSession — memory actions", () => {
    function setup(): { oc: Database; ctx: Database } {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        return { oc, ctx };
    }

    it("move-originated: only this session's memories move; source loses them; both epochs bump", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { withEmbedding: true });
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID); // not this session
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-originated", makeDeps(oc, ctx));

        expect(res.memoriesRelocated).toBe(2);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(2);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
        // embedding followed the moved row (memory_id unchanged on rekey)
        expect(
            (ctx.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as { c: number }).c,
        ).toBe(1);
        expect(res.epochsBumped.sort()).toEqual([FROM, TO].sort());
    });

    it("move-all: every injectable memory moves regardless of origin", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID);
        insertMemory(ctx, FROM, null, { status: "archived" }); // archived excluded
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-all", makeDeps(oc, ctx));
        expect(res.memoriesRelocated).toBe(2);
        // archived stays under source
        expect(
            (
                ctx
                    .prepare(
                        "SELECT COUNT(*) AS c FROM memories WHERE project_path = ? AND status='archived'",
                    )
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
    });

    it("copy-originated: rows duplicated under target, source intact, embeddings duplicated", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { withEmbedding: true });
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "copy-originated", makeDeps(oc, ctx));
        expect(res.memoriesRelocated).toBe(1);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(1);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(1);
        expect(
            (ctx.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as { c: number }).c,
        ).toBe(2);
        // copy bumps only the target epoch
        expect(res.epochsBumped).toEqual([TO]);
    });

    it("move collision: an equivalent memory already at target merges instead of aborting", () => {
        const { oc, ctx } = setup();
        // same category+hash exists at BOTH from and to
        insertMemory(ctx, FROM, SID, { category: "NAMING", content: "dup", withEmbedding: false });
        ctx.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, seen_count, status, created_at)
             VALUES (?, 'NAMING', 'dup', ?, 50, NULL, 5, 'active', 0)`,
        ).run(TO, `hash-${hashCounter}`); // same hash as the FROM row just inserted
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-originated", makeDeps(oc, ctx));
        expect(res.memoriesMerged).toBe(1);
        // source row deleted, target keeps the larger seen_count
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(FROM) as { c: number }
            ).c,
        ).toBe(0);
        expect(
            (
                ctx
                    .prepare(
                        "SELECT seen_count FROM memories WHERE project_path = ? AND normalized_hash = ?",
                    )
                    .get(TO, `hash-${hashCounter}`) as { seen_count: number }
            ).seen_count,
        ).toBe(5);
    });

    it("copy collision: equivalent already at target is skipped (no duplicate)", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { category: "NAMING", content: "dup" });
        ctx.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, seen_count, status, created_at)
             VALUES (?, 'NAMING', 'dup', ?, 50, NULL, 1, 'active', 0)`,
        ).run(TO, `hash-${hashCounter}`);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "copy-originated", makeDeps(oc, ctx));
        expect(res.memoriesSkipped).toBe(1);
        expect(res.memoriesRelocated).toBe(0);
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?")
                    .get(TO) as { c: number }
            ).c,
        ).toBe(1);
    });

    it("move collision: source embedding is preserved on the surviving target (no silent loss)", () => {
        const { oc, ctx } = setup();
        // FROM row HAS an embedding; the equivalent TO row does NOT.
        insertMemory(ctx, FROM, SID, { category: "NAMING", content: "dup", withEmbedding: true });
        const targetId = Number(
            (
                ctx
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, seen_count, status, created_at)
                         VALUES (?, 'NAMING', 'dup', ?, 50, NULL, 1, 'active', 0) RETURNING id`,
                    )
                    .get(TO, `hash-${hashCounter}`) as { id: number }
            ).id,
        );
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const res = applyMigrateSession(plan, "move-originated", makeDeps(oc, ctx));
        expect(res.memoriesMerged).toBe(1);
        // The surviving target row must now carry an embedding adopted from the
        // deleted source — without the transfer the FK-cascade would lose it.
        expect(
            (
                ctx
                    .prepare("SELECT COUNT(*) AS c FROM memory_embeddings WHERE memory_id = ?")
                    .get(targetId) as { c: number }
            ).c,
        ).toBe(1);
    });

    it("compensates the OpenCode move when the context.db transaction fails (no split-brain)", () => {
        const { oc, ctx } = setup();
        // Force the context.db transaction to throw AFTER the OpenCode commit by
        // dropping a table its transaction writes to.
        ctx.exec("DROP TABLE compartment_chunk_embeddings");
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        expect(() => applyMigrateSession(plan, "leave", makeDeps(oc, ctx))).toThrow();
        // OpenCode must be restored to its pre-migration values.
        const session = oc
            .prepare("SELECT directory, project_id FROM session WHERE id = ?")
            .get(SID) as { directory: string; project_id: string };
        expect(session.directory).toBe("/old/dir");
        expect(session.project_id).toBe("global");
    });

    it("refuses to apply when the OpenCode session row is missing (no half-migration)", () => {
        const { oc, ctx } = setup();
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        // Session vanishes between plan and apply (e.g. deleted while we worked).
        oc.prepare("DELETE FROM session WHERE id = ?").run(SID);
        expect(() => applyMigrateSession(plan, "leave", makeDeps(oc, ctx))).toThrow(/not found/i);
        // Context.db must be untouched — ownership stays on the source identity.
        const ownership = ctx
            .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
            .get(SID) as { project_path: string };
        expect(ownership.project_path).toBe(FROM);
    });
});

describe("runMigrateSessionCli under Node", () => {
    // npx runs the published bundle on Node, where node:sqlite has no
    // serialize(): the pre-write snapshots go through the backup API instead.
    // Bun-only tests never reach that path, so this runs the real command in a
    // Node bundle against throwaway databases.
    it("backs up both databases and re-homes the session with node:sqlite", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-migrate-session-node-"));
        try {
            const source = join(root, "source");
            const target = join(root, "target");
            const dataDir = join(root, "data");
            const storeDir = join(dataDir, "cortexkit", "magic-context");
            const opencodeDbPath = join(root, "opencode.db");
            const contextDbPath = join(storeDir, "context.db");
            for (const dir of [source, target, join(root, "config"), storeDir]) {
                mkdirSync(dir, { recursive: true });
            }

            const opencodeDb = new Database(opencodeDbPath);
            opencodeDb.exec(`
                PRAGMA journal_mode=WAL;
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    directory TEXT,
                    path TEXT,
                    workspace_id TEXT,
                    title TEXT
                );
                CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
                INSERT INTO project (id, worktree) VALUES ('global', '/');
            `);
            opencodeDb
                .prepare("INSERT INTO session (id, project_id, directory) VALUES (?, 'global', ?)")
                .run(SID, source);
            opencodeDb.close();
            const contextDb = new Database(contextDbPath);
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            contextDb.close();

            const entry = join(root, "entry.ts");
            const bundle = join(root, "entry.mjs");
            const command = fileURLToPath(new URL("./migrate-session.ts", import.meta.url));
            const prompts = fileURLToPath(new URL("../lib/prompts.ts", import.meta.url));
            const transport = fileURLToPath(
                new URL(
                    "../../../plugin/src/hooks/magic-context/module-transport.ts",
                    import.meta.url,
                ),
            );
            writeFileSync(
                entry,
                `
                import { SubcModuleTransport } from ${JSON.stringify(transport)};
                import { promptIO } from ${JSON.stringify(prompts)};
                import { runMigrateSessionCli } from ${JSON.stringify(command)};
                if (typeof globalThis.Bun !== "undefined") throw new Error("Node test must not expose Bun");
                // No subc module runs here; report the session as unknown to it.
                SubcModuleTransport.prototype.call = async () => ({ row_version: null });
                promptIO.confirm = async () => true;
                const code = await runMigrateSessionCli([
                    "--session", ${JSON.stringify(SID)},
                    "--to", ${JSON.stringify(target)},
                    "--memories", "leave",
                    "--yes",
                ]);
                console.log("RESULT " + JSON.stringify({ code }));
            `,
            );
            const build = spawnSync(
                process.execPath,
                [
                    "build",
                    entry,
                    "--target",
                    "node",
                    "--format",
                    "esm",
                    "--external",
                    "node:sqlite",
                    "--outfile",
                    bundle,
                ],
                { encoding: "utf8", windowsHide: true },
            );
            expect(build.status, build.stderr).toBe(0);
            const run = spawnSync("node", [bundle], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 120_000,
                env: {
                    ...process.env,
                    XDG_CONFIG_HOME: join(root, "config"),
                    XDG_DATA_HOME: dataDir,
                    MAGIC_CONTEXT_TEST_DATA_DIR: dataDir,
                    OPENCODE_DB: opencodeDbPath,
                },
            });
            const resultLine = run.stdout.split("\n").find((line) => line.startsWith("RESULT "));
            expect(resultLine, `${run.stdout}\n${run.stderr}`).toBeDefined();
            expect(
                JSON.parse(resultLine?.slice("RESULT ".length) ?? "{}"),
                `${run.stdout}\n${run.stderr}`,
            ).toEqual({ code: 0 });

            const backupOf = (dir: string, name: string): string => {
                const found = readdirSync(dir).filter((file) => file.startsWith(`${name}.bak-`));
                expect(found).toHaveLength(1);
                return join(dir, found[0] ?? "");
            };
            // A WAL-mode snapshot needs a writable connection to create its -shm file.
            const opencodeBackup = new Database(backupOf(root, "opencode.db"));
            try {
                // The snapshot predates the move, so it still holds the old directory.
                expect(
                    opencodeBackup.prepare("SELECT directory FROM session WHERE id = ?").get(SID),
                ).toEqual({ directory: source });
            } finally {
                opencodeBackup.close();
            }
            const contextBackup = new Database(backupOf(storeDir, "context.db"));
            try {
                expect(
                    contextBackup
                        .prepare(
                            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'memories'",
                        )
                        .get(),
                ).toEqual({ count: 1 });
            } finally {
                contextBackup.close();
            }
            // Once every connection to this WAL store has closed, its -shm file is
            // gone, and a read-only connection cannot create one.
            const moved = new Database(opencodeDbPath);
            try {
                expect(
                    moved.prepare("SELECT directory FROM session WHERE id = ?").get(SID),
                ).toEqual({ directory: realpathSync(target) });
            } finally {
                moved.close();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 180_000);
});

describe("runMigrateSessionCli --yes", () => {
    it("skips the 'OpenCode stopped?' confirmation and re-homes the session", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-migrate-session-yes-"));
        const source = join(root, "source");
        const target = join(root, "target");
        const dataDir = join(root, "data");
        const storeDir = join(dataDir, "cortexkit", "magic-context");
        const opencodeDbPath = join(root, "opencode.db");
        const saved = {
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
            OPENCODE_DB: process.env.OPENCODE_DB,
        };
        const callSpy = spyOn(SubcModuleTransport.prototype, "call").mockResolvedValue({
            row_version: null,
        });
        const confirmSpy = spyOn(promptIO, "confirm").mockImplementation(async (message) => {
            throw new Error(`--yes must not prompt: ${message}`);
        });
        try {
            for (const dir of [source, target, join(root, "config"), storeDir]) {
                mkdirSync(dir, { recursive: true });
            }
            process.env.XDG_CONFIG_HOME = join(root, "config");
            process.env.XDG_DATA_HOME = dataDir;
            process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataDir;
            process.env.OPENCODE_DB = opencodeDbPath;

            const opencodeDb = new Database(opencodeDbPath);
            opencodeDb.exec(`
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    directory TEXT,
                    path TEXT,
                    workspace_id TEXT,
                    title TEXT
                );
                CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
                INSERT INTO project (id, worktree) VALUES ('global', '/');
            `);
            opencodeDb
                .prepare("INSERT INTO session (id, project_id, directory) VALUES (?, 'global', ?)")
                .run(SID, source);
            opencodeDb.close();
            const contextDb = new Database(join(storeDir, "context.db"));
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            contextDb.close();

            expect(
                await runMigrateSessionCli([
                    "--session",
                    SID,
                    "--to",
                    target,
                    "--memories",
                    "leave",
                    "--yes",
                ]),
            ).toBe(0);
            expect(confirmSpy).not.toHaveBeenCalled();
            // Once every connection to this WAL store has closed, its -shm file is
            // gone, and a read-only connection cannot create one.
            const moved = new Database(opencodeDbPath);
            try {
                expect(
                    moved.prepare("SELECT directory FROM session WHERE id = ?").get(SID),
                ).toEqual({ directory: realpathSync(target) });
            } finally {
                moved.close();
            }
        } finally {
            callSpy.mockRestore();
            confirmSpy.mockRestore();
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});
