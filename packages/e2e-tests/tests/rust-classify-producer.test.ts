/// <reference types="bun-types" />

/**
 * Rust-mode lane: the classify dreamer task driven through the real module path
 * (plugin → subc daemon → ck-mc → Broca management surface).
 *
 * The regression this guards: a provider session runs one episode at a time, and a
 * send that arrives while the session still holds an active run is durably QUEUED
 * behind it rather than started. The classifier used one provider session for a whole
 * fallback chain, so whenever an attempt ended without its run ending — a parked run,
 * or one abandoned at the await deadline — the next model's send came back queued.
 * The module read that queued (accepted) reply as a malformed one and failed the whole
 * task with "session.send did not return an active run_id", which named neither the
 * busy session nor the first attempt's real cause. Memories then sat unclassified
 * while the scheduler retried the same collision on every run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

/** The hermetic producer parks the run of any prompt carrying this marker. */
const PAUSE_MARKER = "hermetic-broca-pause-this-run";

interface PoolItem {
    memory_id: number;
    content_hash: string;
}

function normalizedHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
}

function classifyPrompt(project: string, items: PoolItem[], park: boolean): string {
    return [
        "## Task: Classify Project Memories",
        "",
        `**Project:** ${project}`,
        "",
        "Score EVERY memory in the pool below. Emit one <classify> manifest covering every id.",
        "",
        "### Memory pool to classify",
        items
            .map(
                (item) =>
                    `[${item.memory_id}] ARCHITECTURE (current: importance=50 scope=project shareable=false)\n` +
                    `classify lane row ${park ? `${PAUSE_MARKER} ` : ""}${item.memory_id}`,
            )
            .join("\n\n"),
    ].join("\n");
}

describe.skipIf(!rustPrereqs.ok)("rust classify producer", () => {
    let h: RustTestHarness;
    let sessionId: string;
    let projectIdentity: string;
    let items: PoolItem[];

    beforeEach(async () => {
        h = await RustTestHarness.create({
            startInTsMode: true,
            magicContextConfig: { memory: { enabled: true, injection_budget_tokens: 4_000 } },
        });
        sessionId = await h.createSession();

        // One tool-driven write mints the project's memory rows; the rest are seeded
        // directly so the pool is large enough to be a realistic classify batch.
        let bootstrapWrite = false;
        h.mock.addMatcher((body) => {
            if (bootstrapWrite || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                return null;
            }
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const memoryTool = tools.find(
                (tool) =>
                    tool !== null &&
                    typeof tool === "object" &&
                    (tool as { name?: unknown }).name === "ctx_memory",
            ) as { name: string } | undefined;
            if (!memoryTool) return null;
            bootstrapWrite = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_classify_lane_bootstrap",
                        name: memoryTool.name,
                        input: {
                            action: "write",
                            category: "ARCHITECTURE",
                            content: "classify lane corpus row 0",
                        },
                    },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
            };
        });
        await h.sendPrompt(sessionId, "initialize the TypeScript memory store");
        expect(bootstrapWrite).toBe(true);

        const contextDbPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
        const seedDb = new Database(contextDbPath);
        // The host is still running and its post-turn background work (session
        // project backfill, indexing) writes to the same store, so wait for the
        // write lock instead of failing on the first busy attempt.
        seedDb.exec("PRAGMA busy_timeout = 15000");
        try {
            const projectRow = seedDb
                .prepare("SELECT project_path FROM memories ORDER BY id LIMIT 1")
                .get() as { project_path?: string } | undefined;
            projectIdentity = projectRow?.project_path ?? "";
            expect(projectIdentity).toBeTruthy();
            seedDb.transaction(() => {
                const insert = seedDb.prepare(
                    `INSERT INTO memories(
                        project_path, category, content, normalized_hash, importance, scope,
                        shareable, source_session_id, source_type, seen_count, retrieval_count,
                        first_seen_at, created_at, updated_at, last_seen_at, status,
                        verification_status
                    ) VALUES (?, 'ARCHITECTURE', ?, ?, NULL, 'project', 0, ?, 'agent', 1, 0,
                        ?, ?, ?, ?, 'active', 'unverified')`,
                );
                for (let index = 1; index < 12; index += 1) {
                    const content = `classify lane corpus row ${index}`;
                    const now = 1_800_000_000_000 + index;
                    insert.run(
                        projectIdentity,
                        content,
                        normalizedHash(content),
                        sessionId,
                        now,
                        now,
                        now,
                        now,
                    );
                }
            }).immediate();
        } finally {
            seedDb.close();
        }

        // Rust reads the same committed context rows and uses the same memory IDs.
        await h.restart({ rust: true });
        await h.sendPrompt(sessionId, "activate Rust mode for the shared classify corpus");
        await h.waitForRustPasses(1);

        items = (h.contextDb().prepare(
            "SELECT id, normalized_hash FROM memories WHERE project_path = ? AND status = 'active' ORDER BY id",
        ).all(projectIdentity) as Array<{ id: number; normalized_hash: string }>)
            .map(row => ({ memory_id: row.id, content_hash: row.normalized_hash }));
        expect(items.length).toBeGreaterThan(1);
    });

    afterEach(async () => {
        await h?.dispose();
    });

    const runTask = (park: boolean, modelChain: string[]) =>
        h.subc.moduleRequest(sessionId, h.env.workdir, {
            method: "dreamer.run_task",
            task: "classify",
            command_id: `classify:lane:${park ? "park" : "clean"}:${Date.now()}`,
            model_chain: modelChain,
            payload: {
                prompt_body: classifyPrompt(projectIdentity, items, park),
                items,
            },
        });

    it(
        "gives every fallback attempt its own provider session and reports the real cause",
        async () => {
            let failure = "";
            try {
                await runTask(true, ["mock-anthropic/mock-sonnet", "mock-anthropic/mock-haiku"]);
                throw new Error("a chain of parked runs must fail the task");
            } catch (error) {
                failure = (error as { message?: string }).message ?? String(error);
            }

            // The symptom this test exists for: a queued send reported as a shapeless reply.
            expect(failure).not.toContain("did not return an active run_id");
            // Both attempts' causes survive, first one included.
            expect(failure).toContain("mock-anthropic/mock-sonnet");
            expect(failure).toContain("mock-anthropic/mock-haiku");
            expect(failure).toContain("paused");

            const brocaLog = h.subc.producerLog();
            expect(brocaLog).not.toContain("session.send queued");
            const classifySessions = new Set(
                [...brocaLog.matchAll(/session\.send run_id=\S+ session=(mc-dreamer:classify:\S+)/g)].map(
                    (match) => match[1],
                ),
            );
            expect(classifySessions.size).toBe(2);

            // The module's own log carries the request, so an operator can see what ran.
            const moduleLog = h.subc.moduleLog();
            expect(moduleLog).toContain("mc-module: classify attempt=1");
            expect(moduleLog).toContain("mc-module: classify attempt=2");
        },
        300_000,
    );

    it(
        "returns a manifest covering the whole pool on the ordinary path",
        async () => {
            const response = (await runTask(false, ["mock-anthropic/mock-sonnet"])) as {
                ok?: boolean;
                manifest_text?: string;
                diagnostics?: { attempts?: number };
            };
            expect(response.ok).toBe(true);
            expect(response.diagnostics?.attempts).toBe(1);
            const manifest = response.manifest_text ?? "";
            for (const item of items) {
                expect(manifest).toContain(`id="${item.memory_id}"`);
            }
            expect(h.subc.producerLog()).not.toContain("session.send queued");
        },
        300_000,
    );
});
