/// <reference types="bun-types" />

/**
 * Cross-implementation golden for the single-store domain writers.
 *
 * The Rust module and the TypeScript host both write the same `context.db` tables. This
 * runs one logical publish through each of them, on two copies of the same fixture
 * database, and diffs the resulting rows column for column. A difference is a real answer
 * either way: it either names a column the module gets wrong, or it names a column whose
 * value legitimately depends on the writer and therefore has to be handed to both.
 *
 * Two inputs ARE handed to both, because they are inputs rather than results: the wall
 * clock and the harness label. The host reads its own clock inside each writer, so one
 * logical publish picks up several instants a millisecond or two apart; the module stamps
 * one instant on the whole publish. Comparing those would report every timestamp column
 * as diverging and say nothing about the writers, so the clock is frozen for the run and
 * the same frozen value is handed to the module.
 *
 * Production isolation: every database this script touches is created fresh under the
 * system temp directory. It never opens the user's real shared database, and the Rust
 * side refuses a fixture path outside the temp root.
 *
 *   bun scripts/single-store-golden.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertCompartmentEvents } from "../packages/plugin/src/features/magic-context/compartment-events";
import { replaceAllCompartmentState } from "../packages/plugin/src/features/magic-context/compartment-storage";
import { insertMemoryIdempotent } from "../packages/plugin/src/features/magic-context/memory/storage-memory";
import { insertUserMemoryCandidates } from "../packages/plugin/src/features/magic-context/user-memory/storage-user-memory";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { insertPrimerCandidates } from "../packages/plugin/src/features/magic-context/storage-primers";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { getHarness } from "../packages/plugin/src/shared/harness";
import { Database } from "../packages/plugin/src/shared/sqlite";

const REPO_ROOT = join(import.meta.dir, "..");
const SESSION_ID = "ses_golden";
const PROJECT_PATH = "git:golden";
/** Frozen publish instant. Any fixed value works; a fixed one is the point. */
const NOW_MS = 1_700_000_000_000;

/** The tables the two writers are compared on, and the columns compared in each. */
const COMPARED: Record<string, { scope: string; scopeValue: string; order: string }> = {
    compartments: { scope: "session_id", scopeValue: SESSION_ID, order: "sequence ASC" },
    session_facts: {
        scope: "session_id",
        scopeValue: SESSION_ID,
        order: "category ASC, content ASC",
    },
    compartment_events: { scope: "session_id", scopeValue: SESSION_ID, order: "id ASC" },
    memories: { scope: "project_path", scopeValue: PROJECT_PATH, order: "id ASC" },
    primer_candidates: { scope: "project_path", scopeValue: PROJECT_PATH, order: "id ASC" },
    user_memory_candidates: { scope: "session_id", scopeValue: SESSION_ID, order: "id ASC" },
};

const compartments = [
    {
        sequence: 1,
        startMessage: 1,
        endMessage: 4,
        startMessageId: "msg_a",
        endMessageId: "msg_d",
        title: "first",
        content: "first body",
        p1: "first body",
        p2: "shorter",
        p3: null,
        p4: null,
        importance: 70,
        episodeType: "design",
    },
    {
        sequence: 2,
        startMessage: 5,
        endMessage: 9,
        startMessageId: "msg_e",
        endMessageId: "msg_i",
        title: "second",
        content: "second body",
        p1: "second body",
        p2: null,
        p3: null,
        p4: null,
        importance: null,
        episodeType: null,
    },
];

const facts = [
    { category: "Decisions", content: "keep the guards armed" },
    { category: "Open", content: "size the chunk budget" },
];

const events = [
    { kind: "causal_incident", atCompartment: 2, fields: { trigger: "x" } },
    { kind: "trajectory_correction", atCompartment: 9, fields: {} },
];

const memories = [
    {
        category: "ARCHITECTURE" as const,
        content: "The module writes context.db directly",
        importance: 80,
        expiresAt: undefined as number | undefined,
        metadataJson: undefined as string | undefined,
    },
    {
        category: "KNOWN_ISSUES" as const,
        content: "Embeddings arrive from the host backfill",
        importance: undefined as number | undefined,
        expiresAt: 1_800_000_000_000,
        metadataJson: '{"k":1}',
    },
];

const primerQuestion = "How does the fence work?";
const observation = "prefers terse answers";

/**
 * Build the fixture and stamp out the two copies from inside SQLite.
 *
 * `VACUUM INTO` rather than a file copy: the fixture is journalled in WAL mode, so most
 * of what was just written still lives in the sidecar file and a plain copy of the main
 * database would silently hand back a database missing its own migrations.
 */
function buildFixtureAndCopies(fixture: string, copies: string[]): void {
    const db = new Database(fixture);
    try {
        initializeDatabase(db);
        runMigrations(db);
        db.prepare(
            "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0)",
        ).run();
        db.prepare(
            "INSERT OR REPLACE INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, ?, ?, 0)",
        ).run(SESSION_ID, getHarness(), PROJECT_PATH);
        for (const copy of copies) {
            db.prepare("VACUUM INTO ?").run(copy);
        }
    } finally {
        db.close();
    }
}

function runTypeScriptWriters(path: string): { nowMs: number; harness: string } {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    const db = new Database(path);
    try {
        initializeDatabase(db);
        replaceAllCompartmentState(db, SESSION_ID, compartments, facts);
        const compartmentIds = (
            db
                .prepare("SELECT id FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
                .all(SESSION_ID) as Array<{ id: number }>
        ).map((row) => row.id);
        insertCompartmentEvents(db, SESSION_ID, events, compartmentIds);
        for (const memory of memories) {
            insertMemoryIdempotent(db, {
                projectPath: PROJECT_PATH,
                category: memory.category,
                content: memory.content,
                importance: memory.importance,
                sourceSessionId: SESSION_ID,
                expiresAt: memory.expiresAt,
                metadataJson: memory.metadataJson,
            });
        }
        insertPrimerCandidates(db, [
            {
                projectPath: PROJECT_PATH,
                harness: getHarness(),
                sessionId: SESSION_ID,
                question: primerQuestion,
                sourceCompartmentStart: 1,
                sourceCompartmentEnd: 4,
                sourceStartMessageId: "msg_a",
                sourceEndMessageId: "msg_d",
                sourceMessageTime: 1_699_999_000_000,
            },
        ]);
        insertUserMemoryCandidates(db, [
            {
                content: observation,
                sessionId: SESSION_ID,
                sourceCompartmentStart: 1,
                sourceCompartmentEnd: 4,
            },
        ]);

        // The harness label is ambient state the host reads for itself; the module is
        // told which one the host used rather than asked to derive the same answer.
        const stamped = db
            .prepare("SELECT created_at, harness FROM compartments WHERE session_id = ? LIMIT 1")
            .get(SESSION_ID) as { created_at: number; harness: string };
        if (stamped.created_at !== NOW_MS) {
            throw new Error(
                `the frozen clock did not reach the host writers (stamped ${stamped.created_at})`,
            );
        }
        return { nowMs: NOW_MS, harness: stamped.harness };
    } finally {
        db.close();
        Date.now = realNow;
    }
}

function buildModulePublish(nowMs: number, harness: string): unknown {
    return {
        session_id: SESSION_ID,
        project_path: PROJECT_PATH,
        harness,
        now_ms: nowMs,
        compartments: compartments.map((compartment) => ({
            sequence: compartment.sequence,
            start_message: compartment.startMessage,
            end_message: compartment.endMessage,
            start_message_id: compartment.startMessageId,
            end_message_id: compartment.endMessageId,
            title: compartment.title,
            content: compartment.content,
            p1: compartment.p1,
            p2: compartment.p2,
            p3: compartment.p3,
            p4: compartment.p4,
            importance: compartment.importance,
            episode_type: compartment.episodeType,
            created_at: nowMs,
        })),
        facts,
        events: events.map((event) => ({
            kind: event.kind,
            at_compartment: event.atCompartment,
            fields_json: JSON.stringify(event.fields),
        })),
        memories: memories.map((memory) => ({
            category: memory.category,
            content: memory.content,
            importance: memory.importance ?? null,
            source_session_id: SESSION_ID,
            expires_at: memory.expiresAt ?? null,
            metadata_json: memory.metadataJson ?? null,
        })),
        notes: [],
        primer_candidates: [
            {
                question: primerQuestion,
                source_compartment_start: 1,
                source_compartment_end: 4,
                source_start_message_id: "msg_a",
                source_end_message_id: "msg_d",
                source_message_time: 1_699_999_000_000,
                created_at: nowMs,
            },
        ],
        user_observations: [
            {
                content: observation,
                source_compartment_start: 1,
                source_compartment_end: 4,
                created_at: nowMs,
            },
        ],
        user_memories: [],
        user_memory_collection_enabled: true,
    };
}

function readTable(path: string, table: string): Array<Record<string, unknown>> {
    // Read/write, not readonly: both databases are in WAL mode and a reader still needs
    // to be able to create the shared-memory sidecar.
    const db = new Database(path);
    try {
        const spec = COMPARED[table];
        if (!spec) return [];
        return db
            .prepare(`SELECT * FROM ${table} WHERE ${spec.scope} = ? ORDER BY ${spec.order}`)
            .all(spec.scopeValue) as Array<Record<string, unknown>>;
    } finally {
        db.close();
    }
}

interface Divergence {
    table: string;
    row: number;
    column: string;
    ts: unknown;
    module: unknown;
}

function diffTables(tsPath: string, modulePath: string): Divergence[] {
    const divergences: Divergence[] = [];
    for (const table of Object.keys(COMPARED)) {
        const tsRows = readTable(tsPath, table);
        const moduleRows = readTable(modulePath, table);
        if (tsRows.length !== moduleRows.length) {
            divergences.push({
                table,
                row: -1,
                column: "<row count>",
                ts: tsRows.length,
                module: moduleRows.length,
            });
            continue;
        }
        for (let index = 0; index < tsRows.length; index += 1) {
            const tsRow = tsRows[index] ?? {};
            const moduleRow = moduleRows[index] ?? {};
            const columns = new Set([...Object.keys(tsRow), ...Object.keys(moduleRow)]);
            for (const column of columns) {
                const left = tsRow[column] ?? null;
                const right = moduleRow[column] ?? null;
                if (String(left) !== String(right)) {
                    divergences.push({ table, row: index, column, ts: left, module: right });
                }
            }
        }
    }
    return divergences;
}

function main(): number {
    const root = mkdtempSync(join(tmpdir(), "magic-context-single-store-golden-"));
    mkdirSync(root, { recursive: true });
    const fixture = join(root, "fixture.db");
    const tsPath = join(root, "ts.db");
    const modulePath = join(root, "module.db");
    const publishPath = join(root, "publish.json");

    try {
        buildFixtureAndCopies(fixture, [tsPath, modulePath]);

        const { nowMs, harness } = runTypeScriptWriters(tsPath);
        writeFileSync(publishPath, JSON.stringify(buildModulePublish(nowMs, harness), null, 2));

        const cargo = spawnSync(
            "cargo",
            [
                "test",
                "-p",
                "mc-module",
                "--test",
                "single_store_apply",
                "--",
                "--ignored",
                "--nocapture",
            ],
            {
                cwd: REPO_ROOT,
                env: {
                    ...process.env,
                    SINGLE_STORE_GOLDEN_DB: modulePath,
                    SINGLE_STORE_GOLDEN_PUBLISH: publishPath,
                },
                encoding: "utf8",
            },
        );
        process.stdout.write(cargo.stdout ?? "");
        if (cargo.status !== 0) {
            process.stderr.write(cargo.stderr ?? "");
            console.error("single-store golden: the module writer failed to apply the publish");
            return 1;
        }

        const divergences = diffTables(tsPath, modulePath);
        if (divergences.length === 0) {
            console.log("single-store golden: every compared column matches");
            return 0;
        }
        console.log(`single-store golden: ${divergences.length} diverging column(s)`);
        for (const divergence of divergences) {
            console.log(
                `  ${divergence.table}[${divergence.row}].${divergence.column}: ts=${JSON.stringify(divergence.ts)} module=${JSON.stringify(divergence.module)}`,
            );
        }
        return 1;
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

process.exit(main());
