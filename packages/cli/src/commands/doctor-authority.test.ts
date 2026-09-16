import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { SubcModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import { Database } from "@magic-context/core/shared/sqlite";

import { reportAuthorityMarkers, runDoctorDrainAuthority } from "./doctor-authority";

function writeSubcConfig(configHome: string, connectionFile: string): void {
    const configDir = join(configHome, "cortexkit");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(configDir, "magic-context.jsonc"),
        JSON.stringify({ subc: { connection_file: connectionFile } }),
    );
}

function createContextDatabase(path: string, projectPath: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store-test', 0)",
    ).run(projectPath);
    return db;
}

function captureAuthorityStatusConnectionFiles(): {
    paths: string[];
    restore(): void;
} {
    const paths: string[] = [];
    const spy = spyOn(SubcModuleTransport.prototype, "authorityStatus").mockImplementation(
        async function (args) {
            paths.push((this as unknown as { connectionFile: string }).connectionFile);
            return {
                authority: {
                    context_store_uuid: args.context_store_uuid,
                    project: args.project,
                    domain: args.domain,
                    state: "TS",
                    generation: 1,
                },
            };
        },
    );
    return { paths, restore: () => spy.mockRestore() };
}

describe("doctor authority subc configuration", () => {
    it("reportAuthorityMarkers constructs its transport with configured subc.connection_file", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-authority-report-"));
        const originalCwd = process.cwd();
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const configuredConnectionFile = join(root, "configured-subc.json");
        const capture = captureAuthorityStatusConnectionFiles();
        let db: Database | null = null;
        try {
            process.env.XDG_CONFIG_HOME = join(root, "config");
            writeSubcConfig(process.env.XDG_CONFIG_HOME, configuredConnectionFile);
            process.chdir(root);
            db = createContextDatabase(":memory:", resolveProjectIdentity(process.cwd()));

            await reportAuthorityMarkers({ db, info: () => {}, warn: () => {} });

            expect(capture.paths).toEqual([configuredConnectionFile, configuredConnectionFile]);
        } finally {
            db?.close();
            capture.restore();
            process.chdir(originalCwd);
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("runDoctorDrainAuthority constructs its transport with configured subc.connection_file", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-authority-drain-"));
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const configuredConnectionFile = join(root, "configured-subc.json");
        const dbPath = join(root, "context.db");
        const capture = captureAuthorityStatusConnectionFiles();
        try {
            process.env.XDG_CONFIG_HOME = join(root, "config");
            writeSubcConfig(process.env.XDG_CONFIG_HOME, configuredConnectionFile);
            const db = createContextDatabase(dbPath, resolveProjectIdentity(root));
            db.close();

            expect(await runDoctorDrainAuthority(root, dbPath)).toBe(1);
            expect(capture.paths).toEqual([configuredConnectionFile, configuredConnectionFile]);
        } finally {
            capture.restore();
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            rmSync(root, { recursive: true, force: true });
        }
    });
});
