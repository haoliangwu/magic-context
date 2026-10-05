/// <reference types="bun-types" />

/**
 * Show what the block indices on module-published compartments mean.
 *
 *   bun scripts/b2-drill/fold-anchor-probe.ts
 *
 * Drives a hermetic Rust-mode OpenCode session (mock provider, throwaway root) until
 * the historian publishes several compartments, then prints every compartment row next
 * to the module block count of its start and end messages (the same numbering the
 * plugin sends the module, from moduleRawBlockMappings). A row whose end index is the
 * end message's last block covered that message whole; a successor whose start index
 * is its start message's last block is a last-block anchor, not a coverage start.
 */

import { RustTestHarness } from "../../packages/e2e-tests/src/rust-harness";

const h = await RustTestHarness.create({
    modelContextLimit: 30_000,
    historianModelContextLimit: 128_000,
    magicContextConfig: {
        execute_threshold_percentage: 25,
        protected_tags: 1,
        compressor: { enabled: false },
    },
});
try {
    const sessionId = await h.createSession();
    // Tool turns give some messages several module blocks (a call and its result).
    let turn = 0;
    h.mock.addMatcher((body) => {
        const last = JSON.stringify((body.messages as unknown[] | undefined)?.at(-1) ?? "");
        if (!last.includes("PROBE_TOOL") || last.includes("tool_result")) return null;
        turn += 1;
        return {
            content: [
                { type: "text", text: `calling a tool on turn ${turn}` },
                { type: "tool_use", id: `toolu_probe_${turn}`, name: "ctx_note", input: { action: "read" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 500, output_tokens: 20 },
        };
    });
    for (let i = 1; i <= 14; i += 1) {
        h.mock.setDefault({
            text: `assistant ${i}`,
            usage: { input_tokens: 3_000 * i, output_tokens: 20, cache_creation_input_tokens: 2_000 },
        });
        const tool = i % 2 === 0 ? " PROBE_TOOL" : "";
        await h.sendPrompt(sessionId, `probe turn ${i}${tool}: ${h.ballast(2_500)}`);
        await Bun.sleep(300);
    }
    await Bun.sleep(3_000);
    const { Database } = await import("bun:sqlite");
    const { readRawSessionMessagePartsByIdFromDb } = await import(
        "../../packages/plugin/src/hooks/magic-context/read-session-raw"
    );
    const { moduleRawBlockMappings } = await import(
        "../../packages/plugin/src/hooks/magic-context/module-wire"
    );
    // The harness's own throwaway OpenCode database, opened only to read message parts.
    const opencodeDb = new Database(`${h.env.dataDir}/opencode/opencode.db`);
    const blocks = (id: string) =>
        moduleRawBlockMappings(
            readRawSessionMessagePartsByIdFromDb(opencodeDb as never, sessionId, id) as never,
        ).length;
    const rows = h
        .contextDb()
        .query(
            "SELECT sequence, start_message, end_message, start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id = ? ORDER BY sequence",
        )
        .all(sessionId) as Array<Record<string, number | string | null>>;
    for (const row of rows) {
        console.log(
            JSON.stringify({
                ...row,
                start_message_blocks: blocks(row.start_message_id as string),
                end_message_blocks: blocks(row.end_message_id as string),
            }),
        );
    }
    if (rows.length === 0) throw new Error("no compartments published");
} finally {
    await h.dispose();
}
