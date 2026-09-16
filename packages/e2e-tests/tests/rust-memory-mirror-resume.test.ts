/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface CursorSample {
    pass: number;
    cursor: number;
    updated_at: number;
}

function normalizedHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)("rust memory mirror resumption", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: {
                memory: { enabled: true, injection_budget_tokens: 1_000 },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "drains a multi-page activation, resumes a later frontier, and keeps memory tools available",
        async () => {
            const sessionId = await h.createSession();
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
                            id: "toolu_memory_mirror_bootstrap",
                            name: memoryTool.name,
                            input: {
                                action: "write",
                                category: "ARCHITECTURE",
                                content: "hermetic mirror corpus row 0",
                            },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 10,
                        cache_creation_input_tokens: 100,
                    },
                };
            });
            await h.sendPrompt(sessionId, "initialize the TypeScript memory store");
            expect(bootstrapWrite).toBe(true);
            const contextDbPath = join(
                h.env.dataDir,
                "cortexkit",
                "magic-context",
                "context.db",
            );
            const seedDb = new Database(contextDbPath);
            let projectIdentity: string;
            try {
                const projectRow = seedDb
                    .prepare("SELECT project_path FROM memories ORDER BY id LIMIT 1")
                    .get() as { project_path?: string } | undefined;
                expect(projectRow?.project_path).toBeTruthy();
                projectIdentity = projectRow?.project_path ?? "";
                seedDb.transaction(() => {
                    const insert = seedDb.prepare(
                        `INSERT INTO memories(
                            project_path, category, content, normalized_hash, importance, scope,
                            shareable, source_session_id, source_type, seen_count, retrieval_count,
                            first_seen_at, created_at, updated_at, last_seen_at, status,
                            verification_status
                        ) VALUES (?, 'ARCHITECTURE', ?, ?, 50, 'project', 0, ?, 'agent', 1, 0,
                            ?, ?, ?, ?, 'active', 'unverified')`,
                    );
                    for (let index = 1; index < 2_505; index += 1) {
                        const content = `hermetic mirror corpus row ${index}`;
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
                })();
                const seeded = seedDb
                    .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = ?")
                    .get(projectIdentity) as { count: number };
                expect(seeded.count).toBe(2_505);
            } finally {
                seedDb.close();
            }

            await h.restart({ rust: true });
            await h.sendPrompt(sessionId, "activate Rust authority for the seeded corpus");
            await h.waitForRustPasses(1);

            const moduleDbPath = join(
                h.env.dataDir,
                "cortexkit",
                "magic-context",
                "store.db",
            );
            const readFrontier = (): number => {
                const moduleDb = new Database(moduleDbPath, { readonly: true });
                try {
                    const row = moduleDb
                        .prepare(
                            "SELECT COALESCE(MAX(feed_seq), 0) AS head FROM mc_changefeed WHERE domain = 'memories'",
                        )
                        .get() as { head: number };
                    return row.head;
                } finally {
                    moduleDb.close();
                }
            };
            const sampleCursor = (pass: number): CursorSample => {
                const contextDb = new Database(contextDbPath, { readonly: true });
                try {
                    const row = contextDb
                        .prepare(
                            "SELECT cursor, updated_at FROM mirror_cursors WHERE domain = 'memories'",
                        )
                        .get() as { cursor: number; updated_at: number };
                    return { pass, ...row };
                } finally {
                    contextDb.close();
                }
            };

            const initialHead = readFrontier();
            if (initialHead <= 2_000) {
                console.log(`mirror activation diagnostics ${h.diagnosticLog().slice(-4_000)}`);
                console.log(`mirror module diagnostics ${h.subc.moduleLog().slice(-4_000)}`);
            }
            expect(initialHead).toBeGreaterThan(2_000);
            await h.waitFor(
                () => {
                    const sample = sampleCursor(0);
                    return sample.cursor === initialHead ? sample : false;
                },
                { label: "initial multi-page memory mirror drain" },
            );

            const externalWrite = await h.subc.moduleRequest(sessionId, h.env.workdir, {
                name: "ctx_memory",
                arguments: {
                    action: "write",
                    category: "CONSTRAINTS",
                    content: "frontier-only memory written outside the host transform",
                    memory_project: projectIdentity,
                    command_id: `mirror-frontier-${Date.now()}`,
                },
            });
            expect(JSON.stringify(externalWrite)).toContain("Saved memory");
            const advancedHead = readFrontier();
            expect(advancedHead).toBeGreaterThan(initialHead);
            expect(sampleCursor(0).cursor).toBe(initialHead);

            const cursorSamples: CursorSample[] = [];
            let caughtUpModuleCursorAt = 0;
            for (let pass = 1; pass <= 3; pass += 1) {
                await h.sendPrompt(sessionId, `memory mirror resume pass ${pass}`);
                await h.waitFor(
                    () => {
                        const sample = sampleCursor(pass);
                        return sample.cursor === advancedHead ? sample : false;
                    },
                    { label: `memory mirror cursor after pass ${pass}` },
                );
                cursorSamples.push(sampleCursor(pass));
                if (pass === 1) {
                    const caughtUpStatus = await h.subc.moduleStatus(
                        sessionId,
                        h.env.workdir,
                        "session.status",
                    );
                    caughtUpModuleCursorAt = Number(
                        (caughtUpStatus.memory_mirror as { host_cursor_updated_at_ms?: unknown })
                            ?.host_cursor_updated_at_ms ?? 0,
                    );
                    expect(caughtUpModuleCursorAt).toBeGreaterThan(0);
                }
            }
            console.log(`memory-mirror cursor samples ${JSON.stringify(cursorSamples)}`);
            expect(cursorSamples.map((sample) => sample.cursor)).toEqual([
                advancedHead,
                advancedHead,
                advancedHead,
            ]);
            expect(cursorSamples[1]?.updated_at).toBe(cursorSamples[0]?.updated_at);
            expect(cursorSamples[2]?.updated_at).toBe(cursorSamples[1]?.updated_at);

            const moduleStatus = await h.subc.moduleStatus(
                sessionId,
                h.env.workdir,
                "session.status",
            );
            expect(moduleStatus.memory_mirror).toMatchObject({
                feed_head: advancedHead,
                host_cursor: advancedHead,
                host_cursor_updated_at_ms: caughtUpModuleCursorAt,
                stalled: false,
                code: null,
            });

            let toolUseCount = 0;
            const invokeMemoryTool = async (
                input: Record<string, unknown>,
                prompt: string,
            ): Promise<void> => {
                h.mock.reset();
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 20,
                        cache_creation_input_tokens: 100,
                    },
                });
                let emitted = false;
                h.mock.addMatcher((body) => {
                    if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
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
                    emitted = true;
                    toolUseCount += 1;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: `toolu_memory_mirror_${toolUseCount}`,
                                name: memoryTool.name,
                                input,
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 10,
                            cache_creation_input_tokens: 100,
                        },
                    };
                });
                await h.sendPrompt(sessionId, prompt);
                expect(emitted).toBe(true);
            };
            await invokeMemoryTool({ action: "get", ids: [1] }, "read memory through ctx_memory");
            await invokeMemoryTool(
                {
                    action: "write",
                    category: "CONSTRAINTS",
                    content: "host-routed write after mirror recovery",
                },
                "write memory through ctx_memory",
            );
            const toolRoundTrip = JSON.stringify(await h.listMessages(sessionId));
            if (/MC-(?:C0[12]|M02)/.test(toolRoundTrip)) {
                console.log(
                    `memory module diagnostics ${h.subc
                        .moduleLog()
                        .split("\n")
                        .filter((line) => line.includes("TEMP facade proof miss"))
                        .join("\n")}`,
                );
                console.log(
                    `memory tool diagnostics ${h
                        .diagnosticLog()
                        .split("\n")
                        .filter((line) => /ctx_memory|authority|capability|mirror_pull/.test(line))
                        .slice(-80)
                        .join("\n")}`,
                );
            }
            expect(toolUseCount).toBe(2);
            expect(toolRoundTrip).toContain("hermetic mirror corpus row 0");
            expect(toolRoundTrip).toContain("Saved memory");
            expect(toolRoundTrip).not.toContain("MC-C01");
            expect(toolRoundTrip).not.toContain("MC-C02");
            expect(toolRoundTrip).not.toContain("MC-M02");
        },
        300_000,
    );
});
