// Measure the cold (first call in a fresh process) and warm cost of history
// embedding coverage on a fully embedded session whose compartments carry
// realistic amounts of text: 394 compartments of 60 messages each, about 10 MB of
// message text and over a dozen windows per compartment. Benchmarks built from
// one-line compartments (such as issue-564-bench.ts next to this file) cannot
// show this cost, because it grows with the amount of text rather than with the
// number of compartments.
//
// Every measurement runs in a child process so the process-local window memo
// starts empty, exactly as after a host restart. All data lives in a throwaway
// temp directory. Run `bun packages/plugin/scripts/issue-604-bench.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "../src/hooks/magic-context/read-session-formatting";
import * as chunks from "../src/features/magic-context/compartment-chunk-embedding";
import {
    backfillMessageFtsRowidMapBatch,
    recordMessageFtsRowid,
} from "../src/features/magic-context/message-fts-rowid-map";
import { runMigrations } from "../src/features/magic-context/migrations";
import { recordSessionProjectIdentity } from "../src/features/magic-context/session-project-storage";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { Database } from "../src/shared/sqlite";

const PROJECT = "/synthetic/issue-604";
const MODEL = "mock:issue-604";
const SESSION = "synthetic-394";
const COMPARTMENTS = 394;
const MESSAGES_PER_COMPARTMENT = 60;
const MAX_INPUT_TOKENS = 512;

// Deterministic pseudo-random text mixing prose, identifiers, paths and numbers,
// so token density is closer to a coding session than repeated English.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}
const VOCABULARY = (
    "the a to of and in is that for it with as on this be are by not from or at " +
    "function return const let import export async await interface type class " +
    "compartment embedding window coverage session transcript token chunk hash " +
    "packages/plugin/src/features/magic-context/storage.ts src/index.ts README.md " +
    "error: expected undefined null true false 0x1f 404 2048 3.14 => {} [] () ; " +
    "should could would please fix test build lint commit branch merge review"
).split(/\s+/);

function messageText(random: () => number): string {
    const words = 20 + Math.floor(random() * 90);
    const out: string[] = [];
    for (let i = 0; i < words; i++) {
        const word = VOCABULARY[Math.floor(random() * VOCABULARY.length)];
        out.push(random() < 0.08 ? `${word}_${Math.floor(random() * 100_000)}` : word);
    }
    return out.join(" ");
}

function openDb(path: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    // Marks the rowid map complete so transcript spans are readable.
    backfillMessageFtsRowidMapBatch(db);
    return db;
}

function buildStore(path: string): void {
    const db = openDb(path);
    try {
        const random = createRandom(604);
        const insertCompartment = db.prepare(`INSERT INTO compartments
            (session_id, sequence, start_message, end_message, title, content, p1, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertFts = db.prepare(`INSERT INTO message_history_fts
            (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)`);
        recordSessionProjectIdentity(db, SESSION, PROJECT);
        let textBytes = 0;
        db.transaction(() => {
            let ordinal = 1;
            for (let c = 0; c < COMPARTMENTS; c++) {
                const start = ordinal;
                for (let m = 0; m < MESSAGES_PER_COMPARTMENT; m++) {
                    const content = messageText(random);
                    textBytes += content.length;
                    const role = m % 2 === 0 ? "user" : "assistant";
                    const id = insertFts.run(SESSION, ordinal, `m${ordinal}`, role, content)
                        .lastInsertRowid;
                    recordMessageFtsRowid(db, SESSION, ordinal, id);
                    ordinal++;
                }
                insertCompartment.run(
                    SESSION,
                    c,
                    start,
                    ordinal - 1,
                    `Compartment ${c}`,
                    "summary",
                    "summary",
                    Date.now(),
                );
            }
        }).immediate();
        console.log(`store: ${COMPARTMENTS} compartments, ${(textBytes / 1e6).toFixed(1)} MB text`);
    } finally {
        db.close();
    }
}

// Embed every compartment with its current windows. `withSource` passes the
// window source key when this build of the plugin accepts one.
function embedAll(path: string, withSource: boolean): void {
    const db = openDb(path);
    try {
        const rows = db
            .prepare(
                "SELECT id, start_message AS s, end_message AS e FROM compartments WHERE session_id = ? ORDER BY id",
            )
            .all(SESSION) as Array<{ id: number; s: number; e: number }>;
        const sourceKeyFn = (chunks as Record<string, unknown>).chunkWindowSourceKey as
            | ((text: string, s: number, e: number, max: number) => string)
            | undefined;
        if (withSource && !sourceKeyFn) throw new Error("this build has no chunkWindowSourceKey");
        let windowCount = 0;
        for (const row of rows) {
            const text = chunks.buildCanonicalChunkTextFromFts(db, SESSION, row.s, row.e) ?? "";
            const windows = chunks.chunkCanonicalText(text, row.s, row.e, MAX_INPUT_TOKENS);
            windowCount += windows.length;
            const save = chunks.replaceCompartmentChunkEmbeddings as (
                db: Database,
                rows: chunks.SaveCompartmentChunkEmbeddingInput[],
                sourceKey?: string,
            ) => void;
            save(
                db,
                windows.map((window) => ({
                    compartmentId: row.id,
                    sessionId: SESSION,
                    projectPath: PROJECT,
                    window,
                    modelId: MODEL,
                    vector: new Float32Array([1, 0]),
                })),
                withSource && sourceKeyFn
                    ? sourceKeyFn(text, row.s, row.e, MAX_INPUT_TOKENS)
                    : undefined,
            );
        }
        console.log(`embedded: ${rows.length} compartments, ${windowCount} windows`);
    } finally {
        db.close();
    }
}

async function timed(label: string, job: () => unknown): Promise<void> {
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    const result = await job();
    const cpu = process.cpuUsage(cpuStart);
    console.log(
        `  ${label}: wall=${(performance.now() - start).toFixed(0)}ms cpu=${(
            (cpu.user + cpu.system) / 1000
        ).toFixed(0)}ms result=${JSON.stringify(result)}`,
    );
}

async function runPhase(phase: string, path: string): Promise<void> {
    const db = openDb(path);
    // Load the tokenizer before timing; a host has it loaded by the first transform.
    estimateTokens("warm up the tokenizer");
    try {
        if (phase === "polite") {
            const run = () =>
                chunks.countSessionCompartmentEmbedCoveragePolite(
                    db,
                    PROJECT,
                    SESSION,
                    MODEL,
                    MAX_INPUT_TOKENS,
                );
            await timed("polite cold", run);
            await timed("polite warm", run);
        } else if (phase === "sync") {
            const run = () =>
                chunks.countSessionCompartmentEmbedCoverage(
                    db,
                    PROJECT,
                    SESSION,
                    MODEL,
                    MAX_INPUT_TOKENS,
                );
            await timed("sync cold", run);
            await timed("sync warm", run);
        } else if (phase === "lease-scan") {
            await timed("lease-held candidate scan", async () =>
                (
                    await chunks.loadUnembeddedSessionChunkCandidatesPolite(
                        db,
                        PROJECT,
                        SESSION,
                        MODEL,
                        10,
                        [],
                        MAX_INPUT_TOKENS,
                        true,
                    )
                ).length,
            );
        }
    } finally {
        db.close();
    }
}

function child(phase: string, path: string): void {
    const result = Bun.spawnSync([process.execPath, import.meta.path, phase, path], {
        stdout: "inherit",
        stderr: "inherit",
    });
    if (result.exitCode !== 0) throw new Error(`phase ${phase} failed`);
}

const [phase, phasePath] = process.argv.slice(2);
if (phase && phasePath) {
    await runPhase(phase, phasePath);
} else {
    const dir = mkdtempSync(join(tmpdir(), "issue-604-bench-"));
    const path = join(dir, "context.db");
    try {
        buildStore(path);
        embedAll(path, false);
        console.log("rows written without a window source (legacy rows):");
        child("polite", path);
        child("sync", path);
        if ((chunks as Record<string, unknown>).chunkWindowSourceKey) {
            console.log("one lease-held scan over the legacy rows:");
            child("lease-scan", path);
            console.log("after that scan, in a new process:");
            child("polite", path);
            child("sync", path);
            embedAll(path, true);
            console.log("rows written with their window source:");
            child("polite", path);
            child("sync", path);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
