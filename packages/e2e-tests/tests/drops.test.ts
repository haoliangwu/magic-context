/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOutboundShapeProbe } from "../src/opencode2-runner/outbound-shape-probe";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

function countRows(h: ScenarioHarness, table: "pending_ops" | "tags", sessionId: string): number {
    const status = table === "tags" ? " AND status = 'dropped'" : "";
    const row = h.contextDb()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND harness = ?${status}`)
        .get(sessionId, h.harnessId) as { n: number } | null;
    return row?.n ?? 0;
}

forEachHost(import.meta.url, "drops", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        // Pending operations apply only on a cache-busting pass. The force-band
        // sample and real message mass move the target beyond the protected tail.
        h = await createScenarioHarness(host, {
            modelContextLimit: 20_000,
            magicContextConfig: { protected_tokens: 4_000, execute_threshold_percentage: 20 },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    it("drains pending_ops when drops are queued", async () => {
        h.mock.reset();
        h.mock.setDefault({
            content: Array.from({ length: 24 }, (_, index) => ({
                type: "text",
                text: `drop aging block ${index + 1}: ${h.ballast(200)}`,
            })),
            usage: { input_tokens: 18_000, output_tokens: 10, cache_creation_input_tokens: 0 },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "first drop target", { timeoutMs: 60_000 });
        await h.waitFor(() => h.countTags(sessionId) > 0, { label: "tag ready" });

        const writable = openTestDb(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, ?)",
                )
                .run(sessionId, Date.now(), h.harnessId);
        } finally {
            writable.close();
        }

        h.mock.reset();
        h.mock.setDefault({
            text: "second response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 },
        });
        await h.sendPrompt(sessionId, "second turn force-busts and drains pending ops", {
            timeoutMs: 60_000,
        });

        expect(countRows(h, "pending_ops", sessionId)).toBe(0);
        expect(countRows(h, "tags", sessionId)).toBeGreaterThan(0);
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 60_000);

    // The assertions above read rows we wrote and a substring of the provider request.
    // Neither describes the shape of the messages the plugin hands back to the host, and on
    // OpenCode 2 that shape is schema-checked: a part type outside the content union fails
    // the whole turn before it reaches the provider. The drop pipeline rewrites a CLONE of a
    // tool part, so only the v2 adapter can map it back, and it maps by object identity.
    // Assert the emitted part types directly — whether a given host build happens to tolerate
    // a bad part is a property of that build, not evidence that we emitted a good one.
    if (host === "opencode2") {
        it("emits only V2 content types on the turn after a tool arc is dropped", async () => {
            // A separate host, because this case needs several real tool arcs and no historian
            // competing for the mock provider; the scenario above is tuned for neither.
            const probe = createOutboundShapeProbe();
            const v2 = await createScenarioHarness(host, {
                modelContextLimit: 100_000,
                magicContextConfig: {
                    protected_tokens: 4_000,
                    execute_threshold_percentage: 20,
                    historian: { disable: true },
                },
                probePlugin: probe.plugin,
            });
            try {
                const target = join(v2.workdir, "drop-target.txt");
                writeFileSync(
                    target,
                    Array.from(
                        { length: 120 },
                        (_, line) => `line ${line}: ${v2.ballast(20)}`,
                    ).join("\n"),
                );

                // Several arcs in one turn: the drop target has to stay inside the recent
                // tool-skeleton window (with its small input) to be kept as a skeleton rather
                // than removed outright, and only the skeleton path rewrites a clone.
                v2.mock.reset();
                let step = 0;
                v2.mock.addMatcher(() => {
                    if (++step > 6) return null;
                    return {
                        content: [
                            {
                                type: "tool_use" as const,
                                id: `toolu_drop_shape_${step}`,
                                name: "read",
                                input: { path: target },
                            },
                        ],
                        stop_reason: "tool_use" as const,
                        usage: {
                            input_tokens: 9_000,
                            output_tokens: 10,
                            cache_creation_input_tokens: 0,
                        },
                    };
                });
                v2.mock.setDefault({
                    text: "arcs done",
                    usage: { input_tokens: 9_000, output_tokens: 10, cache_creation_input_tokens: 0 },
                });

                const sessionId = await v2.createSession();
                await v2.sendPrompt(sessionId, "read the drop target repeatedly", {
                    timeoutMs: 120_000,
                });

                // Queue the drop against a tool tag, not tag 1: only a tool tag takes the
                // clone-and-swap path. pending_ops.tag_id holds a tag_number.
                const toolTag = await v2.waitFor(
                    () =>
                        v2
                            .contextDb()
                            .prepare(
                                "SELECT tag_number FROM tags WHERE session_id = ? AND harness = ? AND type = 'tool' ORDER BY tag_number LIMIT 1",
                            )
                            .get(sessionId, v2.harnessId) as { tag_number: number } | null,
                    { label: "tool arc tagged" },
                );
                const writable = openTestDb(v2.contextDbPath());
                try {
                    writable
                        .prepare(
                            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
                        )
                        .run(sessionId, toolTag.tag_number, Date.now(), v2.harnessId);
                    // Force the priced pass explicitly; a small host window can compact
                    // away the arcs before this outbound-shape guard exercises them.
                    writable.prepare("UPDATE session_meta SET cached_m0_system_hash = 'stale' WHERE session_id = ?").run(sessionId);
                } finally {
                    writable.close();
                }

                // One turn to drain the queued drop, one more to carry the dropped arc into a
                // request. The leak is in what we emit, so it shows on both; the second turn is
                // the one a user reaches once the drop is already frozen in the store.
                v2.mock.reset();
                v2.mock.setDefault({
                    text: "second response",
                    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 },
                });
                await v2.sendPrompt(sessionId, "turn that drains the queued drop", {
                    timeoutMs: 120_000,
                });
                await v2.sendPrompt(sessionId, "turn after the drop", { timeoutMs: 120_000 });

                // Non-vacuity, part one: the arc must actually have been kept as a skeleton. A tool tag
                // reclaimed by removal, or not reclaimed at all, never produces the part this
                // guards, and everything below would then hold for the wrong reason.
                expect(
                    v2
                        .contextDb()
                        .prepare(
                            "SELECT status, drop_mode FROM tags WHERE session_id = ? AND harness = ? AND tag_number = ?",
                        )
                        .get(sessionId, v2.harnessId, toolTag.tag_number),
                ).toEqual({ status: "dropped", drop_mode: "skeleton_real" });

                const records = probe.records().filter((record) => record.sessionID === sessionId);
                expect(records.length).toBeGreaterThan(0);

                // Non-vacuity, part two: a request with no tool parts at all would satisfy the
                // union check trivially. The dropped arc must still be there, as V2 tool parts.
                expect(
                    records.filter((record) => record.types.includes("tool-call")).length,
                ).toBeGreaterThan(0);

                expect(probe.nonV2(sessionId)).toEqual([]);
            } finally {
                await v2.dispose();
            }
        }, 240_000);
    }
});
