/**
 * Before/after cost of the four serving-thread stalls Magic Context's host
 * profiler attributed to the plugin, on a synthetic OpenCode session of about
 * 150k messages.
 *
 *   STALL_SRC=<plugin src dir> STALL_ROOT=<throwaway dir> bun scripts/perf-audit/stall-cost.ts
 *
 * STALL_SRC selects the implementation (this checkout's src by default, or an
 * extracted older src) so the same driver measures both. Every database is
 * created under STALL_ROOT; nothing outside it is opened. The search store is
 * built once and reused, so a before and an after run search the same corpus.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve(process.env.STALL_SRC ?? join(import.meta.dir, "../../src"));
const rootValue = process.env.STALL_ROOT;
if (!rootValue) throw new Error("STALL_ROOT (a throwaway directory) is required");
const root = resolve(rootValue);
for (const forbidden of ["/.local/share/opencode", "/cortexkit/magic-context", "/.config/"]) {
    if (`${root}/`.includes(forbidden)) throw new Error(`refusing a root inside ${forbidden}`);
}
mkdirSync(root, { recursive: true });
const label = process.env.STALL_LABEL ?? "run";
const MESSAGES = Number(process.env.STALL_MESSAGES ?? 150_000);
const SESSION = "ses_stall_cost";

type Fn = (...args: unknown[]) => unknown;
async function load(path: string): Promise<Record<string, Fn>> {
    return (await import(join(src, path))) as Record<string, Fn>;
}

const sqlite = await load("shared/sqlite.ts");
const DatabaseClass = sqlite.Database as unknown as new (
    path: string,
    options?: { readonly?: boolean },
) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
    transaction(fn: () => void): () => void;
    close(): void;
};
type Db = InstanceType<typeof DatabaseClass>;

function time(run: () => unknown): number {
    const started = performance.now();
    run();
    return performance.now() - started;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

const results: Record<string, unknown> = { label, src, messages: MESSAGES };

// 1. Canonical ordinal of a newly indexed message (the incremental index timer).
{
    const fixture = await load("features/magic-context/__tests__/opencode1-query-fixture.ts");
    const raw = await load("hooks/magic-context/read-session-raw.ts");
    const path = join(root, `${label}-opencode.db`);
    const db = new DatabaseClass(path);
    db.exec(fixture.OPENCODE1_MESSAGE_PART_SCHEMA as unknown as string);
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const padding = "p".repeat(200);
    const data = (index: number) =>
        JSON.stringify(
            index % 1000 === 999
                ? { role: "assistant", summary: true, finish: "stop", padding }
                : { role: index % 2 ? "assistant" : "user", finish: "stop", padding },
        );
    const id = (index: number) => `msg_${String(index).padStart(8, "0")}`;
    db.transaction(() => {
        for (let index = 0; index < MESSAGES; index += 1) {
            // Four messages share each timestamp, as bursts of tool steps do.
            const created = 1_700_000_000_000 + Math.floor(index / 4);
            insert.run(id(index), SESSION, created, created, data(index));
        }
    })();
    const read = raw.readRawSessionMessageByIdFromDb as (
        db: Db,
        session: string,
        id: string,
    ) => { ordinal: number } | null;
    // MESSAGES - 2 is an ordinary message (every 1000th is a compaction marker).
    const cold = time(() => read(db, SESSION, id(MESSAGES - 2)));
    const warm: number[] = [];
    let lastOrdinal = 0;
    for (let step = 0; step < 20; step += 1) {
        const index = MESSAGES + step;
        const created = 1_700_000_000_000 + MESSAGES + step;
        insert.run(id(index), SESSION, created, created, data(index));
        warm.push(time(() => (lastOrdinal = read(db, SESSION, id(index))?.ordinal ?? -1)));
    }
    // Lookups with no write in between, as ctx_expand rendering several
    // messages does: the corrected watermark is reused only in this case.
    const unchanged: number[] = [];
    for (let step = 1; step <= 20; step += 1) {
        unchanged.push(time(() => read(db, SESSION, id(MESSAGES + 20 - step))));
    }
    results.ordinal = {
        cold_ms: round(cold),
        appended_lookup_median_ms: round(median(warm)),
        appended_lookup_max_ms: round(Math.max(...warm)),
        unchanged_store_lookup_median_ms: round(median(unchanged)),
        last_ordinal: lastOrdinal,
    };
    db.close();
}

// 2. Explicit ctx_search with literal probes (per-probe FTS match counts).
{
    const storageDb = await load("features/magic-context/storage-db.ts");
    const messageIndex = await load("features/magic-context/message-index.ts");
    const search = await load("features/magic-context/search.ts");
    const client = await load("hooks/magic-context/auto-search-worker-client.ts");
    const path = join(root, "search-context.db");
    const fresh = !existsSync(path);
    const db = new DatabaseClass(path);
    storageDb.initializeDatabase(db);
    if (fresh) {
        const words = ["queue", "drain", "worker", "retry", "budget", "cache", "index", "probe"];
        const messages = Array.from({ length: MESSAGES }, (_, index) => ({
            ordinal: index + 1,
            id: `msg_${index}`,
            role: index % 2 ? "assistant" : "user",
            parts: [
                {
                    type: "text",
                    text: [
                        index % 3 === 0 ? "cache_timeout" : "retry_budget",
                        index % 97 === 0 ? "src/config.json" : "notes.md",
                        words[index % words.length],
                        words[(index * 7) % words.length],
                        `step ${index}`,
                    ].join(" "),
                },
            ],
        }));
        messageIndex.ensureMessagesIndexed(db, SESSION, () => messages);
    }
    const query = "where does cache_timeout in src/config.json reach the worker queue";
    const options = {
        sources: ["message"],
        limit: 10,
        embeddingEnabled: false,
        isEmbeddingRuntimeEnabled: () => false,
        explicitSearch: true,
        countRetrievals: false,
        measurementDisabled: true,
    };
    // The longest gap between 2 ms ticks is the longest the event loop was held.
    async function measure(extra: Record<string, unknown>) {
        let last = performance.now();
        let longest = 0;
        const ticker = setInterval(() => {
            const now = performance.now();
            longest = Math.max(longest, now - last);
            last = now;
        }, 2);
        const started = performance.now();
        const found = (await search.unifiedSearch(db, SESSION, "git:stall", query, {
            ...options,
            ...extra,
        })) as Array<{ messageId?: string }>;
        const total = performance.now() - started;
        clearInterval(ticker);
        longest = Math.max(longest, performance.now() - last);
        return { total, longest, ids: found.map((hit) => hit.messageId ?? "") };
    }
    await measure({});
    const inProcess = await measure({});
    const entry: Record<string, unknown> = {
        in_process_total_ms: round(inProcess.total),
        in_process_longest_event_loop_block_ms: round(inProcess.longest),
        result_ids: inProcess.ids.join(","),
    };
    const offThread = client.searchMessageHistoryOffThread;
    if (typeof offThread === "function") {
        const delegated = await measure({
            searchMessageHistory: (request: unknown) => offThread(db, request),
        });
        entry.off_thread_total_ms = round(delegated.total);
        entry.off_thread_longest_event_loop_block_ms = round(delegated.longest);
        entry.off_thread_same_results = delegated.ids.join(",") === inProcess.ids.join(",");
    }
    results.search = entry;
    db.close();
}

// 3. keep_reasoning_tokens projection on every pass.
{
    const storageDb = await load("features/magic-context/storage-db.ts");
    const tags = await load("features/magic-context/storage-tags.ts");
    const meta = await load("features/magic-context/storage-meta-persisted.ts");
    const decisions = await load("features/magic-context/merged-reasoning-decisions.ts");
    const budget = await load("hooks/magic-context/reasoning-budget.ts");
    const db = new DatabaseClass(join(root, `${label}-reasoning-context.db`));
    storageDb.initializeDatabase(db);
    let tagNumber = 0;
    const addTags = (messageIndex: number) => {
        const owner = `msg_${messageIndex}`;
        tags.insertTag(db, SESSION, owner, "message", 100, ++tagNumber, 40, null, 0, null, null, {
            tokenCount: 25,
            inputTokenCount: 0,
            reasoningTokenCount: 30 + (messageIndex % 50),
        });
        tags.insertTag(db, SESSION, `call_${messageIndex}`, "tool", 300, ++tagNumber, 0, "read", 20, owner);
    };
    db.transaction(() => {
        for (let index = 0; index < MESSAGES; index += 1) addTags(index);
    })();
    const LIVE = 2_000;
    const messages = Array.from({ length: LIVE }, (_, offset) => {
        const index = MESSAGES - LIVE + offset;
        return index % 2
            ? {
                  info: { id: `msg_${index}`, role: "assistant", tokens: { reasoning: 0 } },
                  parts: [
                      { id: `prt_${index}_0`, type: "reasoning", text: "thinking ".repeat(30) },
                      { type: "tool", tool: "read", callID: `call_${index}`, state: { status: "completed" } },
                      { id: `prt_${index}_1`, type: "reasoning", text: "more ".repeat(20) },
                  ],
              }
            : { info: { id: `msg_${index}`, role: "user" }, parts: [{ type: "text", text: "go on" }] };
    });
    const frozen: string[] = [];
    for (let offset = 1; offset < LIVE; offset += 4) {
        const index = MESSAGES - LIVE + offset;
        frozen.push(
            `${decisions.MERGED_REASONING_PARTS_PREFIX as unknown as string}${JSON.stringify([`msg_${index}`, [`prt_${index}_1`]])}`,
            `msg_${index}`,
        );
    }
    meta.addMergedReasoningStrippedIds(db, SESSION, frozen);
    const project = () =>
        budget.projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 10_000, 0, 1) as number;
    let cutoff = 0;
    const cold = time(() => (cutoff = project()));
    const passes: number[] = [];
    const estimatePasses: number[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
        addTags(MESSAGES + pass);
        passes.push(time(() => (cutoff = project())));
        estimatePasses.push(time(() => tags.getReasoningTokenEstimatesByMessage(db, SESSION, 1)));
    }
    results.reasoning_budget = {
        tags: tagNumber,
        live_messages: LIVE,
        frozen_decisions: frozen.length,
        cold_ms: round(cold),
        pass_median_ms: round(median(passes)),
        pass_max_ms: round(Math.max(...passes)),
        compartment_trigger_estimates_median_ms: round(median(estimatePasses)),
        cutoff,
    };
    db.close();
}

// 4. Last-good request entry digests.
{
    const lkg = await load("hooks/magic-context/lkg-slot.ts");
    lkg.resetLkgSlotsForTest();
    // OpenCode rebuilds the message objects for every request.
    const pass = (length: number) =>
        Array.from({ length }, (_, index) => ({
            info: { id: `msg_${String(index).padStart(8, "0")}`, role: index % 2 ? "assistant" : "user" },
            parts: [{ type: "text", text: `message ${index} `.repeat(8) }],
        }));
    const anchor = (messages: Array<{ info: { id: string } }>) =>
        lkg.captureSlot(SESSION, {
            jsonPrefix: "[]",
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: messages.at(-1)?.info.id ?? "",
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        });
    let length = MESSAGES;
    let messages = pass(length);
    anchor(messages);
    const cold = time(() => lkg.noteEntry(SESSION, messages));
    const passes: number[] = [];
    for (let step = 0; step < 5; step += 1) {
        length += 3;
        messages = pass(length);
        anchor(messages);
        passes.push(time(() => lkg.noteEntry(SESSION, messages)));
    }
    results.lkg_entry = {
        prefix_messages: length,
        cold_ms: round(cold),
        pass_median_ms: round(median(passes)),
        pass_max_ms: round(Math.max(...passes)),
    };
    lkg.resetLkgSlotsForTest();
}

const output = JSON.stringify(results, null, 2);
writeFileSync(join(root, `${label}.json`), output);
console.log(output);
