import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestTempDir, createTestTempDir } from "../src/shared/test-temp-dir";

const roots: string[] = [];
const plugin = resolve(import.meta.dir, "..");
const repo = resolve(plugin, "../..");
afterEach(() => {
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

describe("stale split plugin builds", () => {
    for (const host of ["pi", "opencode"] as const) {
        it(`${host} smart-note dry runs report a removed lazy chunk once without blaming the note`, async () => {
            const { dir } = createTestTempDir("mc-stale-build-");
            const root = realpathSync(dir);
            roots.push(dir);
            const dist = join(root, "dist");
            mkdirSync(dist);
            const entry = join(root, "entry.ts");
            writeFileSync(join(root, "other.ts"), 'export const value = "another lazy feature";');
            const notice = join(repo, host === "pi"
                ? "packages/pi-plugin/src/stale-build-notice.ts"
                : "packages/plugin/src/plugin/stale-build-notice.ts");
            writeFileSync(entry, `
                export { dryRunSmartNoteCheck } from ${JSON.stringify(join(plugin, "src/features/magic-context/smart-notes/compiler.ts"))};
                export { log, setLogLineForwarder } from ${JSON.stringify(join(plugin, "src/shared/logger.ts"))};
                import { importPluginModule } from ${JSON.stringify(join(plugin, "src/shared/stale-plugin-build.ts"))};
                export const loadOther = () => importPluginModule(() => import("./other.ts"));
                export { bindStaleBuildNotice } from ${JSON.stringify(notice)};
            `);
            const built = await Bun.build({
                entrypoints: [entry], outdir: dist, target: "node", format: "esm", splitting: true,
                define: { "process.env.NODE_ENV": '"production"' },
                external: ["bun:sqlite", "node:sqlite", "onnxruntime-node", "onnxruntime-web", "sharp"],
            });
            expect(built.success).toBe(true);
            const chunks = built.outputs.filter((file) => file.kind === "chunk").map((file) => file.path);
            expect(chunks.length).toBeGreaterThan(0);
            const probe = join(root, "probe.mjs");
            writeFileSync(probe, `
                import { unlinkSync } from "node:fs";
                import * as api from ${JSON.stringify(join(dist, "entry.js"))};
                const notifications = [], logs = [];
                api.setLogLineForwarder((line) => logs.push(line));
                const surface = ${host === "pi"
                        ? '{ hasUI: true, ui: { notify: (message) => notifications.push(message) } }'
                        : '{ tui: { showToast: async ({ body }) => notifications.push(body.message) } }'};
                api.bindStaleBuildNotice(surface, ${JSON.stringify(new URL(`file://${join(dist, "entry.js")}`).href)});
                for (const chunk of ${JSON.stringify(chunks)}) unlinkSync(chunk);
                const caps = () => ({ readFile: async () => "", gitHeadSha: async () => "", gitTag: async () => "", gitLog: async () => "", httpGet: async () => ({ status: 200, text: "" }) });
                const results = await Promise.all(Array.from({ length: 3 }, () => api.dryRunSmartNoteCheck("function check(cap) { return { met: false }; }", caps)));
                // A later wake logs the cached import rejection again through a
                // different catch path. It must not produce another diagnostic.
                for (const result of results) if (!result.ok) api.log("compile failed: " + result.error);
                const smartNoteLogs = [...logs];
                let otherError;
                try { await api.loadOther(); } catch (error) { otherError = error.message; api.log("another feature failed", error); }
                api.log("ordinary diagnostic", { value: 4 });
                console.log(JSON.stringify({ notifications, logs, smartNoteLogs, results, otherError }));
            `);
            const result = spawnSync(host === "pi" ? "node" : process.execPath, [probe], {
                encoding: "utf8", timeout: 20_000,
                env: { ...process.env, NODE_ENV: "production", MAGIC_CONTEXT_LOG_PATH: join(root, "plugin.log") },
            });
            expect(result.status).toBe(0);
            const report = JSON.parse(result.stdout.trim());
            expect(report.results).toHaveLength(3);
            expect(report.results.map((run: { ok: boolean; cancelled: boolean; error: string }) => ({ ok: run.ok, cancelled: run.cancelled, error: run.error }))).toEqual(Array(3).fill({
                ok: false, cancelled: true, error: host === "pi"
                    ? "Magic Context was rebuilt while this Pi was running; type /reload to load the new build"
                    : "Magic Context was rebuilt while this OpenCode host was running; restart the host to load the new build",
            }));
            const guidance = host === "pi"
                ? "Magic Context was rebuilt while this Pi was running; type /reload to load the new build"
                : "Magic Context was rebuilt while this OpenCode host was running; restart the host to load the new build";
            expect(report.notifications).toEqual([guidance]);
            expect(report.smartNoteLogs).toHaveLength(1);
            expect(report.smartNoteLogs[0]).toContain("stale plugin build");
            expect(report.smartNoteLogs[0].trim().split("\n")).toHaveLength(1);
            expect(report.otherError).toBe(guidance);
            expect(report.logs).toHaveLength(3);
            expect(report.logs[1]).toContain("stale plugin build");
            expect(report.logs[2]).toContain('ordinary diagnostic {"value":4}');
            expect(report.results.every((run: { error: string }) => run.error === guidance)).toBe(true);
        });
    }
});
