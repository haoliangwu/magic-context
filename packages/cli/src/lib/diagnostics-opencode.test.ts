import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    collectOpenCodePluginCacheReport,
    collectRecentSessionsFromDatabase,
    openCodeIssueLogHarnesses,
    type RecentSessionSummary,
} from "./diagnostics-opencode";

// The OpenCode 2 plugin logs to <tmp>/opencode2/magic-context/, not the
// OpenCode 1 subtree; an issue report on an OpenCode 2 host that read only the
// OpenCode 1 log attached a file that stopped growing at the upgrade.
describe("issue report log selection", () => {
    it("reads the OpenCode 2 plugin log first on an OpenCode 2 host", () => {
        expect(openCodeIssueLogHarnesses("v2")).toEqual(["opencode2", "opencode"]);
    });
    it("reads only the OpenCode 1 plugin log on an OpenCode 1 host", () => {
        expect(openCodeIssueLogHarnesses("v1")).toEqual(["opencode"]);
    });
});

// Fixture caches live under a throwaway XDG_CACHE_HOME; the real cache is never read.
describe("issue report plugin cache", () => {
    let root: string;
    let cache: string;
    const savedCacheHome = process.env.XDG_CACHE_HOME;

    beforeEach(() => {
        root = createTestTempDirFromPath(join(tmpdir(), "mc-diag-cache-"));
        cache = join(root, "cache");
        process.env.XDG_CACHE_HOME = cache;
    });
    afterEach(() => {
        if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = savedCacheHome;
        rmSync(root, { recursive: true, force: true });
    });

    const writePackage = (dir: string, version: string) => {
        const packageDir = join(dir, "node_modules", "@cortexkit", "opencode-magic-context");
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
    };
    const v2Slot = (spec: string) =>
        join(cache, "opencode", "npm", "@cortexkit", `opencode-magic-context@${spec}`);
    const v1Root = () =>
        join(cache, "opencode", "packages", "@cortexkit", "opencode-magic-context@latest");

    it("reports the OpenCode 2 slot the host loads, and every install in both layouts", () => {
        writePackage(v1Root(), "0.30.0");
        writePackage(join(v2Slot("latest"), "1790000000000"), "0.42.6");
        writePackage(join(v2Slot("latest"), "1790000000001"), "0.43.1");
        writePackage(join(v2Slot("beta"), "1790000000000"), "0.44.0-beta.2");

        const report = collectOpenCodePluginCacheReport("v2", {
            plugins: ["@cortexkit/opencode-magic-context@latest"],
        });
        expect(report.path).toBe(v2Slot("latest"));
        expect(report.cached).toBe("0.43.1");
        expect(report.installs).toEqual([
            { layout: "opencode1", spec: "latest", path: v1Root(), cached: "0.30.0" },
            { layout: "opencode2", spec: "latest", path: v2Slot("latest"), cached: "0.43.1" },
            { layout: "opencode2", spec: "beta", path: v2Slot("beta"), cached: "0.44.0-beta.2" },
        ]);
    });

    it("follows a dist-tag entry to that tag's slot on OpenCode 2", () => {
        writePackage(join(v2Slot("latest"), "1790000000000"), "0.43.1");
        writePackage(join(v2Slot("next"), "1790000000000"), "0.45.0-next.1");
        const report = collectOpenCodePluginCacheReport("v2", {
            plugin: [["@cortexkit/opencode-magic-context@next", {}]],
        });
        expect(report.path).toBe(v2Slot("next"));
        expect(report.cached).toBe("0.45.0-next.1");
    });

    it("keeps reporting the packages tree on OpenCode 1", () => {
        writePackage(v1Root(), "0.30.0");
        writePackage(join(v2Slot("latest"), "1790000000000"), "0.43.1");
        const report = collectOpenCodePluginCacheReport("v1", null);
        expect(report.path).toBe(v1Root());
        expect(report.cached).toBe("0.30.0");
        expect(report.installs?.map((install) => install.layout)).toEqual([
            "opencode1",
            "opencode2",
        ]);
    });
});

describe("collectRecentSessionsFromDatabase", () => {
    it("includes newest children under recent parents while keeping the picker capped", () => {
        const database = new Database(":memory:");
        try {
            database.exec(`
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT NOT NULL,
                    title TEXT,
                    time_updated INTEGER NOT NULL,
                    parent_id TEXT,
                    time_archived INTEGER
                )
            `);
            const insert = database.prepare(
                "INSERT INTO session (id, directory, title, time_updated, parent_id, time_archived) VALUES (?, ?, ?, ?, ?, ?)",
            );
            const add = (
                id: string,
                timeUpdated: number,
                parentId: string | null = null,
                archived: number | null = null,
            ) => insert.run(id, "/project", id, timeUpdated, parentId, archived);

            add("ses_parent001", 100);
            add("ses_child001", 300, "ses_parent001");
            add("ses_child002", 290, "ses_parent001");
            add("ses_child003", 280, "ses_parent001");
            add("ses_child004", 270, "ses_parent001");
            add("ses_child_archived", 400, "ses_parent001", 1);
            add("ses_parent002", 250);
            add("ses_parent003", 240);
            add("ses_parent004", 230);
            add("ses_parent005", 220);
            add("ses_parent006", 210);

            const sessions = collectRecentSessionsFromDatabase(database);
            const ids = sessions.map((session) => session.sessionId);
            expect(ids).toEqual([
                "ses_parent001",
                "ses_child001",
                "ses_child002",
                "ses_child003",
                "ses_parent002",
                "ses_parent003",
                "ses_parent004",
                "ses_parent005",
            ]);
            expect(ids).not.toContain("ses_child004");
            expect(ids).not.toContain("ses_parent006");
            expect(sessions[1]).toMatchObject<Partial<RecentSessionSummary>>({
                sessionId: "ses_child001",
                parentSessionId: "ses_parent001",
            });
        } finally {
            database.close();
        }
    });
});
