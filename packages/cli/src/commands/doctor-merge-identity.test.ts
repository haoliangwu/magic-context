import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { CLI_SCHEMA_FLOOR_VERSION, OutdatedSchemaVersionError } from "../lib/database-access";
import { runMergeIdentityCli } from "./doctor-merge-identity";

const tempDirs: string[] = [];

function tempDir(): string {
    const root = join(tmpdir(), "magic-context", "identity-merge-tests");
    mkdirSync(root, { recursive: true });
    const path = realpathSync(createTestTempDirFromPath(join(root, "fixture-")));
    tempDirs.push(path);
    return path;
}

function createVersionedDatabase(path: string, version: number): void {
    const db = new Database(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    db.close();
}

function createCurrentDatabase(path: string): void {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.close();
}

function fileHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("doctor merge-identity schema guard", () => {
    it("refuses a database one fence below the checkout without changing its bytes", () => {
        const path = join(tempDir(), "context.db");
        createVersionedDatabase(path, CLI_SCHEMA_FLOOR_VERSION - 1);
        const before = fileHash(path);

        expect(() =>
            runMergeIdentityCli([
                "--from",
                "dir:source",
                "--to",
                "dir:target",
                "--db",
                path,
                "--yes",
            ]),
        ).toThrow(OutdatedSchemaVersionError);
        expect(() =>
            runMergeIdentityCli([
                "--from",
                "dir:source",
                "--to",
                "dir:target",
                "--db",
                path,
                "--yes",
            ]),
        ).toThrow("Run a session or doctor migrate first");
        expect(fileHash(path)).toBe(before);
    });

    // Explicit ceiling: createCurrentDatabase replays the full migration
    // chain, whose wall time grows with every release and crossed bun's 5s
    // default under CI load at v76 (release run 31447211517).
    it("works against the current checkout schema without running migrations", () => {
        const path = join(tempDir(), "context.db");
        createCurrentDatabase(path);
        const fixture = new Database(path);
        fixture.exec(
            "INSERT INTO project_state(project_path) VALUES ('dir:source'), ('dir:target')",
        );
        fixture.close();

        expect(
            runMergeIdentityCli(
                ["--from", "dir:source", "--to", "dir:target", "--db", path, "--apply", "--force"],
                {
                    inspectHolders: () => ({ safe: true, blockers: [] }),
                    probe: () => ({ status: "free" }),
                },
            ),
        ).toBe(0);

        const db = new Database(path);
        const version = db
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as { version: number };
        const target = db
            .prepare("SELECT project_path FROM project_state WHERE project_path = ?")
            .get("dir:target");
        db.close();
        expect(version.version).toBe(CLI_SCHEMA_FLOOR_VERSION);
        expect(target).toBeDefined();
    }, 30_000);
});

describe("offline identity command", () => {
    function fixture() {
        const path = join(tempDir(), "context.db");
        createCurrentDatabase(path);
        const db = new Database(path);
        db.exec("INSERT INTO project_state(project_path) VALUES ('dir:source'), ('git:target')");
        db.close();
        return {
            path,
            args: ["--db", path, "--from", "dir:source", "--to", "git:target", "--force"],
        };
    }
    it("preview writes nothing and unknown identities refuse by name", () => {
        const { path, args } = fixture();
        const before = fileHash(path);
        expect(runMergeIdentityCli(args)).toBe(0);
        expect(fileHash(path)).toBe(before);
        expect(() =>
            runMergeIdentityCli([
                "--db",
                path,
                "--from",
                "dir:absent",
                "--to",
                "git:target",
                "--force",
            ]),
        ).toThrow("Unknown identity: dir:absent");
        expect(fileHash(path)).toBe(before);
    }, 30_000);
    it("holders refuse before backups and writes", () => {
        const { path, args } = fixture();
        const before = fileHash(path);
        expect(() =>
            runMergeIdentityCli([...args, "--apply"], {
                inspectHolders: () => ({ safe: true, blockers: [] }),
                probe: () => ({ status: "in_use", pids: [123] }),
            }),
        ).toThrow("context.db holders: 123");
        expect(fileHash(path)).toBe(before);
    }, 30_000);
    it("different git directories refuse even with force", () => {
        const { path } = fixture();
        const db = new Database(path);
        db.exec(`INSERT INTO project_state(project_path) VALUES ('git:source');
            INSERT INTO workspaces VALUES (1,'shared',1,1,'[]');
            INSERT INTO workspace_members VALUES (1,'git:source','source','/different/source',1),(1,'git:target','target','/different/target',1)`);
        db.close();
        expect(() =>
            runMergeIdentityCli([
                "--db",
                path,
                "--from",
                "git:source",
                "--to",
                "git:target",
                "--force",
            ]),
        ).toThrow("different directories");
    }, 30_000);
    it("an unresolved target requires force and equal identities always refuse", () => {
        const { path } = fixture();
        expect(() =>
            runMergeIdentityCli(["--db", path, "--from", "dir:source", "--to", "git:target"]),
        ).toThrow("does not resolve");
        expect(() =>
            runMergeIdentityCli([
                "--db",
                path,
                "--from",
                "dir:source",
                "--to",
                "dir:source",
                "--force",
            ]),
        ).toThrow("must differ");
    }, 30_000);
});

it("repairs a real same-directory split, backs up and updates the sidecar after commit", () => {
    const directory = tempDir();
    execFileSync("git", ["init", directory], { stdio: "ignore", windowsHide: true });
    execFileSync(
        "git",
        [
            "-C",
            directory,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
        { stdio: "ignore", windowsHide: true },
    );
    const identity = `git:${execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()}`;
    const path = join(directory, "context.db");
    createCurrentDatabase(path);
    const db = new Database(path);
    db.prepare(
        "INSERT INTO session_projects VALUES ('old','opencode','dir:source',1),('new','opencode',?,1)",
    ).run(identity);
    db.close();
    const host = new Database(join(directory, "host.db"));
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    host.prepare("INSERT INTO session VALUES ('old',?),('new',?)").run(directory, directory);
    host.close();
    const before = fileHash(path);
    const args = ["--db", path, "--from", "dir:source", "--to", identity];
    expect(runMergeIdentityCli(["--db", path])).toBe(0);
    expect(runMergeIdentityCli(args)).toBe(0);
    expect(fileHash(path)).toBe(before);
    // Keep the real lsof database-holder check. Stub global RPC/Pi discovery so
    // unrelated hosts on the test machine cannot block this private fixture.
    const deps = { inspectHolders: () => ({ safe: true, blockers: [] }) };
    expect(runMergeIdentityCli([...args, "--apply"], deps)).toBe(0);
    const backup = readdirSync(directory).find((name) => name.startsWith("identity-merge-backup-"));
    expect(backup).toBeDefined();
    expect(fileHash(join(directory, backup as string, "context.db"))).toBe(before);
    const sidecars = join(directory, "project-identities");
    expect(JSON.parse(readFileSync(join(sidecars, readdirSync(sidecars)[0]), "utf8"))).toEqual({
        directory,
        identity,
    });
    const after = new Database(path);
    expect(after.prepare("SELECT DISTINCT project_path FROM session_projects").all()).toEqual([
        { project_path: identity },
    ]);
    after.close();
    const hash = fileHash(path);
    expect(runMergeIdentityCli([...args, "--apply"], deps)).toBe(0);
    expect(fileHash(path)).toBe(hash);
}, 30_000);
