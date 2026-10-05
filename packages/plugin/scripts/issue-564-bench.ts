// Compare synchronous and yielding coverage counts for 1,500 historical
// compartments, then probe embedded, failed and fresh-session states. All data
// stays in memory; run `bun packages/plugin/scripts/issue-564-bench.ts`.
import { performance } from "node:perf_hooks";
import { Database } from "../src/shared/sqlite";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { runMigrations } from "../src/features/magic-context/migrations";
import { recordMessageFtsRowid } from "../src/features/magic-context/message-fts-rowid-map";
import { recordSessionProjectIdentity } from "../src/features/magic-context/session-project-storage";
import {
    countSessionCompartmentEmbedCoverage,
    countSessionCompartmentEmbedCoveragePolite,
    countUnembeddedSessionCompartments,
    countUnembeddedSessionCompartmentsPolite,
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
    recordChunkEmbedBackoff,
} from "../src/features/magic-context/compartment-chunk-embedding";

const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const project = "/synthetic/issue-564";
const model = "mock:issue-564";
const session = "synthetic-1500";
const text = "Synthetic historical text with sufficient token content and no live data. ".repeat(16);
const insertCompartment = db.prepare(`INSERT INTO compartments
    (session_id, sequence, start_message, end_message, title, content, p1, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertFts = db.prepare(`INSERT INTO message_history_fts
    (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, 'user', ?)`);
recordSessionProjectIdentity(db, session, project);
db.transaction(() => {
    for (let i = 1; i <= 1500; i++) {
        insertCompartment.run(session, i, i, i, `Summary ${i}`, text, text, Date.now());
        const id = insertFts.run(session, i, `m${i}`, text).lastInsertRowid;
        recordMessageFtsRowid(db, session, i, id);
    }
}).immediate();
const first = db.prepare("SELECT id FROM compartments WHERE session_id = ? ORDER BY id LIMIT 1").get(session) as { id: number };
const firstWindow = chunkCanonicalText(`[1] U: ${text}`, 1, 1, 512)[0];
const rows = db.prepare("SELECT id FROM compartments WHERE session_id = ? ORDER BY id").all(session) as Array<{ id: number }>;
const fill = () => {
    for (let i = 0; i < rows.length; i++) {
        replaceCompartmentChunkEmbeddings(db, [{
            compartmentId: rows[i].id, sessionId: session, projectPath: project,
            window: { ...firstWindow, text: `[${i + 1}] U: ${text}`,
                chunkHash: chunkCanonicalText(`[${i + 1}] U: ${text}`, i + 1, i + 1, 512)[0].chunkHash,
                startOrdinal: i + 1, endOrdinal: i + 1 },
            modelId: model, vector: new Float32Array([1, 0]),
        }]);
    }
};
async function measure(label: string, job: () => void | Promise<unknown>): Promise<void> {
    let drift = 0;
    let expected = performance.now() + 10;
    const timer = setInterval(() => {
        drift = Math.max(drift, performance.now() - expected);
        expected = performance.now() + 10;
    }, 10);
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    await job();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    clearInterval(timer);
    const cpu = process.cpuUsage(cpuStart);
    console.log(`${label}: wall=${(performance.now() - start).toFixed(1)}ms cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms longest-drift=${drift.toFixed(1)}ms`);
}
try {
    await measure("backlog synchronous baseline", () => {
        countSessionCompartmentEmbedCoverage(db, project, session, model);
        countUnembeddedSessionCompartments(db, project, session, model);
    });
    await measure("backlog polite memo", async () => {
        await countSessionCompartmentEmbedCoveragePolite(db, project, session, model);
        await countUnembeddedSessionCompartmentsPolite(db, project, session, model);
    });
    fill();
    await measure("fully embedded polite", () => countSessionCompartmentEmbedCoveragePolite(db, project, session, model));
    recordChunkEmbedBackoff(db, { id: first.id, sessionId: session, startMessage: 1, endMessage: 1, title: "Summary 1" }, project, model);
    await measure("unembeddable polite", () => countSessionCompartmentEmbedCoveragePolite(db, project, session, model));
    recordSessionProjectIdentity(db, "fresh-one-message", project);
    await measure("fresh session polite", () => countSessionCompartmentEmbedCoveragePolite(db, project, "fresh-one-message", model));
} finally {
    db.close();
}
