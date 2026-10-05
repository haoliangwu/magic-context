#!/usr/bin/env bun
// Synthetic, isolated stage measurements. No host or live store is opened.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFrozenMergedReasoningParts } from "../../src/features/magic-context/merged-reasoning-decisions";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "../../src/features/magic-context/storage-meta-session";
import { getSourceContents } from "../../src/features/magic-context/storage-source";
import { getActiveTagTokenTotalsByMessage, getAllStatusTagTokenTotalsFlat, getDroppedTagsByNumbers, getInertWhitespaceAssistantTags, getTagById, getTagNumberByMessageId, getTailHygieneTags } from "../../src/features/magic-context/storage-tags";
import { createTagger } from "../../src/features/magic-context/tagger";
import { estimateFinalWireInputTokens } from "../../src/hooks/magic-context/final-wire-token-estimate";
import { injectM0M1, mustMaterialize } from "../../src/hooks/magic-context/inject-compartments";
import { postprocessReplaySnapshot, postprocessTailTags } from "../../src/hooks/magic-context/postprocess-read-cache";
import { estimateTokens } from "../../src/hooks/magic-context/read-session-formatting";
import { tagMessages, type MessageLike } from "../../src/hooks/magic-context/tag-messages";
import * as hygieneWalk from "../../src/hooks/magic-context/tail-hygiene-walk";
import { ToolMutationBatch } from "../../src/hooks/magic-context/tool-drop-target";
import { Database } from "../../src/shared/sqlite";

const root = mkdtempSync(join(tmpdir(), "mc-perf-tx-"));
const { assertTailHygieneContentUnchanged, assertTailHygieneContentUnchangedIfEnabled, measureTailHygiene, refreshTailHygieneBaseline, tailHygieneStructuralSignature } = hygieneWalk;
process.env.XDG_DATA_HOME = root;
process.env.XDG_CACHE_HOME = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "plugin.log");
const sessionId = "tx-fixture";
const repeats = 3;
const only = Bun.argv.find(arg => arg.startsWith("--only="))?.slice(7);
function time(finding: string, size: number, run: () => unknown) {
    if (only && !finding.includes(only)) return;
    run();
    const samples = Array.from({ length: repeats }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(JSON.stringify({ finding, messages: size, medianMs: +samples[1].toFixed(3) }));
}
console.log(`Bun ${Bun.version}; 18 TX findings; medians of ${repeats} warm samples; root=${root}`);
try {
    for (const size of [1000, 10000, 60000]) {
        const db = new Database(join(root, `${size}.db`));
        initializeDatabase(db);
        getOrCreateSessionMeta(db, sessionId);
        const messages: MessageLike[] = Array.from({ length: size }, (_, i) => ({
            info: { id: `msg-${i}`, role: i % 2 ? "assistant" : "user", sessionID: sessionId },
            parts: [{ type: "text", text: `Request ${i}: ` + "Inspect the source and preserve the cached prefix. ".repeat(12) }],
        }));
        const insert = db.prepare("INSERT INTO tags (session_id, tag_number, message_id, type, status, byte_size, token_count, harness) VALUES (?, ?, ?, 'message', 'active', 600, 110, 'opencode')");
        const source = db.prepare("INSERT INTO source_contents (session_id, tag_id, content, created_at, harness) VALUES (?, ?, ?, 0, 'opencode')");
        db.transaction(() => {
            for (let i = 0; i < size; i++) {
                insert.run(sessionId, i + 1, `msg-${i}:p0`);
                source.run(sessionId, i + 1, (messages[i].parts[0] as { text: string }).text);
            }
        })();
        if (only === "plans") {
            for (const sql of [
                "SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ? ORDER BY tag_number ASC LIMIT 1",
                "SELECT MIN(tag_number) FROM tags WHERE session_id = ? AND message_id = ?",
                "SELECT tag_id, content FROM source_contents WHERE session_id = ? AND tag_id IN (SELECT value FROM json_each(?))",
            ]) console.log(JSON.stringify({ size, sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(sessionId, "msg-1:p0") }));
            db.close();
            continue;
        }
        const tags = getTailHygieneTags(db, sessionId);
        const protectedTagNumbers = new Set<number>();
        const input = { messages, tags, protectedTagNumbers };
        const initial = refreshTailHygieneBaseline({ ...input, cacheBusting: true });
        let turn = 0;
        const appended = [...messages, { info: { id: "new-tail", role: "user" }, parts: [{ type: "text", text: "New tail" }] }];
        time("TX-2 append refresh", size, () => {
            appended[appended.length - 1].info.id = `new-tail-${turn++}`;
            return refreshTailHygieneBaseline({ ...input, messages: appended, previous: initial, cacheBusting: false });
        });
        time("TX-3 assertion (default guard enabled before fix)", size, () => {
            if (Bun.argv.includes("--after")) {
                assertTailHygieneContentUnchangedIfEnabled({ ...input, expectedSignature: initial.contentSignature });
            } else if (process.env.NODE_ENV !== "production") {
                assertTailHygieneContentUnchanged({ ...input, expectedSignature: initial.contentSignature });
            }
        });
        time("TX-4 warm content walk", size, () => measureTailHygiene(input));
        time("TX-5 final estimate", size, () => estimateFinalWireInputTokens({ messages, systemPromptTokens: 1000, providerID: "anthropic", modelID: "claude-sonnet-4-5", agentName: "build" }));
        time("TX-6 unchanged metadata write", size, () => updateSessionMeta(db, sessionId, { conversationTokens: 110 * size, toolCallTokens: 0 }));
        const renderOptions = { db, sessionId, state: getOrCreateSessionMeta(db, sessionId), injectDocs: false, memoryEnabled: false, isCacheBustingPass: false };
        injectM0M1(renderOptions);
        // Persist realistic 48 KiB m0 and 12 KiB m1 bodies without changing markers.
        renderOptions.state.cachedM0Bytes = Buffer.from("History baseline. ".repeat(2800));
        renderOptions.state.cachedM1Bytes = Buffer.from("Recent additions. ".repeat(700));
        updateSessionMeta(db, sessionId, { cachedM0Bytes: renderOptions.state.cachedM0Bytes, cachedM1Bytes: renderOptions.state.cachedM1Bytes });
        time("TX-1 cached head inject", size, () => injectM0M1(renderOptions));
        time("TX-7 decision x3", size, () => { for (let i = 0; i < 3; i++) mustMaterialize(renderOptions); });
        time("TX-8 active tag reads x3", size, () => { for (let i = 0; i < 3; i++) getTailHygieneTags(db, sessionId); });
        time("TX-8 token totals (one new id)", size, () => getActiveTagTokenTotalsByMessage(db, sessionId, Bun.argv.includes("--after") ? [`msg-${size - 1}`] : undefined));
        db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(JSON.stringify(messages.map(m => m.info.id)), sessionId);
        time("TX-9 warm replay copy", size, () => postprocessReplaySnapshot(db, sessionId));
        time("TX-9 invalidated replay", size, () => { updateSessionMeta(db, sessionId, { conversationTokens: size }); postprocessReplaySnapshot(db, sessionId); postprocessTailTags(db, sessionId); });
        const numbers = Array.from({ length: size }, (_, i) => i + 1);
        time("TX-10 source read", size, () => getSourceContents(db, sessionId, numbers));
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        time("TX-10/11/13 tag replay", size, () => tagMessages(sessionId, structuredClone(messages), tagger, db));
        time("TX-11 scoped inert lookup", size, () => getInertWhitespaceAssistantTags(db, sessionId, messages.map(m => m.info.id as string)));
        const head = injectM0M1(renderOptions).preparedMessages;
        time("TX-12 head clone", size, () => structuredClone(head));
        const muralHead = structuredClone(head ?? []);
        muralHead[0]?.parts.push({ type: "file", mime: "image/png", url: `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`, synthetic: true });
        time("TX-12 2-MiB mural head clone", size, () => structuredClone(muralHead));
        time("TX-12 head presence read", size, () => db.prepare("SELECT cached_m0_bytes AS m0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?").get(sessionId));
        time("TX-13 whitespace probes", size, () => {
            for (let i = 0; i < size; i++) {
                getTagNumberByMessageId(db, sessionId, `msg-${i}:p0`);
                getSourceContents(db, sessionId, [i + 1]);
                getTagById(db, sessionId, i + 1);
            }
        });
        time("TX-14 dropped lookup", size, () => getDroppedTagsByNumbers(db, sessionId, numbers));
        time("TX-15 batch compaction (half removed)", size, () => {
            const wire = messages.map(m => ({ info: m.info, parts: [...m.parts] }));
            const batch = new ToolMutationBatch(wire, true);
            for (let i = 0; i < size; i += 2) batch.markForRemoval({ message: wire[i], part: wire[i].parts[0], kind: "result" });
            batch.finalize();
        });
        time("TX-16 retained map entries", size, () => new Map(messages.map(m => [m.info.id, { conversation: 110, toolCall: 0 }])));
        const frozen = new Set(messages.map(m => `__merged_reasoning_parts_v1__:${JSON.stringify([m.info.id, [1]])}`));
        time("TX-17 reasoning parse", size, () => readFrozenMergedReasoningParts(frozen));
        time("TX-18 boundary token preload", size, () => getAllStatusTagTokenTotalsFlat(db, sessionId));
        time("TX-18 hypothetical scoped preload (not a runtime fix)", size, () => getAllStatusTagTokenTotalsFlat(db, sessionId, size - 32));
        time("TX-note structural guard x2", size, () => { tailHygieneStructuralSignature(messages); tailHygieneStructuralSignature(messages); });
        db.close();
    }
} finally {
    rmSync(root, { recursive: true, force: true });
}
