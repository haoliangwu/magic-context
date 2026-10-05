/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { insertMemory } from "../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { openDatabase } from "../../plugin/src/features/magic-context/storage";
import { closeQuietly } from "../../plugin/src/shared/sqlite-helpers";
import { createScenarioHarness, forEachHost, type ScenarioHarness } from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

let h: ScenarioHarness;
const task = "classify-memories";

forEachHost(import.meta.url, "Pi 0.87 model chain validation", () => {
    beforeAll(async () => {
        h = await createScenarioHarness("pi", {
            magicContextConfig: { dreamer: {
                disable: false,
                pi: { model: "anthropic/claude-haiku-4-5" },
                tasks: { [task]: { schedule: "0 3 * * *" } },
            } },
        });
    });
    afterAll(async () => { await h?.dispose(); });

    it("uses its valid primary without spawning the unknown fallback", async () => {
        h.mock.setDefault({ text: "ack", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
        const session = await h.createSession();
        await h.sendPrompt(session, "bootstrap Pi dreamer");
        await h.waitFor(() => h.hasContextDb(), { label: "Pi context store" });
        const configPath = join(dirname(h.dataDir), "config", "cortexkit", "magic-context.jsonc");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.dreamer.pi.fallback_models = ["ollama-cloud/deepseek-v4-flash:0731"];
        writeFileSync(configPath, JSON.stringify(config));
        await h.reloadPlugin();
        const project = resolveProjectIdentity(realpathSync(resolve(h.workdir)));
        const db = openDatabase({ dbPath: h.contextDbPath() });
        if (!db) throw new Error("throwaway context store unavailable");
        let ids: number[];
        try {
            ids = Array.from({ length: 10 }, (_, i) => insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: `Pi model fixture ${i}` }).id);
            db.prepare(`INSERT INTO task_schedule_state (project_path, task, next_due_at, schedule, retry_count)
                VALUES (?, ?, ?, NULL, 0) ON CONFLICT(project_path, task) DO UPDATE SET next_due_at=excluded.next_due_at, last_status=NULL, retry_count=0`).run(project, task, Date.now() - 60_000);
        } finally { closeQuietly(db); }
        h.mock.setDefault({ text: `<classify>${ids.map((id) => `<memory id="${id}" importance="80" scope="project" shareable="true"/>`).join("")}</classify>`, usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
        await h.waitFor(() => {
            const store = openTestDb(h.contextDbPath());
            try { return (store.prepare("SELECT last_status FROM task_schedule_state WHERE project_path=? AND task=?").get(project, task) as { last_status: string | null } | null)?.last_status === "completed"; }
            finally { store.close(); }
        }, { timeoutMs: 240_000, label: "Pi classified pool" });
        const logPath = join(tmpdir(), "magic-context", "host-extract-cache", "pi", "magic-context", "magic-context.log");
        await h.waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("dropping Pi model not found: ollama-cloud/deepseek-v4-flash:0731"), { label: "Pi model warning" });
        const store = openTestDb(h.contextDbPath());
        try {
            expect((store.prepare("SELECT count(*) AS n FROM memories WHERE project_path=? AND classified_at IS NOT NULL").get(project) as { n: number }).n).toBe(10);
            const models = store.prepare("SELECT provider_id, model_id FROM subagent_invocations WHERE task=?").all(task) as Array<{ provider_id: string; model_id: string }>;
            expect(models.some((row) => row.provider_id === "anthropic" && row.model_id === "claude-haiku-4-5")).toBe(true);
            expect(models.some((row) => row.provider_id === "ollama-cloud")).toBe(false);
        } finally { store.close(); }
    }, 300_000);
});
