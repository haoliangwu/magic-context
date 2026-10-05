/** Offline MEM probes. The seed must be a VACUUM copy under $TMPDIR/magic-context. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDreamTaskBacklog, getDreamTaskBacklogs, evaluateTaskGate } from "../../src/features/magic-context/dreamer/task-gates";
import { CANONICAL_DREAM_TASKS } from "../../src/features/magic-context/dreamer/task-registry";
import { buildVerifyDiffEvidence } from "../../src/features/magic-context/dreamer/verify-diff";
import { searchGitCommitsSync } from "../../src/features/magic-context/git-commits/search-git-commits";
import { loadProjectCommitEmbeddings } from "../../src/features/magic-context/git-commits/storage-git-commit-embeddings";
import * as cosine from "../../src/features/magic-context/memory/cosine-similarity";
import { getProjectEmbeddings, resetEmbeddingCacheForTests } from "../../src/features/magic-context/memory/embedding-cache";
import { getMemoriesByProject, getUnclassifiedMemoryIds } from "../../src/features/magic-context/memory/storage-memory";
import * as memoryStorage from "../../src/features/magic-context/memory/storage-memory";
import { searchMemoriesFTSUnion } from "../../src/features/magic-context/memory/storage-memory-fts";
import { getMemoryVerifications } from "../../src/features/magic-context/memory/storage-memory-verifications";
import { normalizeVerificationFiles, readGitFileChangeTimesSince, readGitChangedFilesSince, resolveGitTopLevel } from "../../src/features/magic-context/memory/verification-paths";
import { getMuralCoverage, resolveMural } from "../../src/features/magic-context/mural/resolve-mural";
import * as mural from "../../src/features/magic-context/mural/resolve-mural";
import { computeCueContentHash, getMuralCueState, memoryNeedsCue } from "../../src/features/magic-context/mural/storage-mural-cues";
import { unifiedSearch, formatSearchResults } from "../../src/features/magic-context/search";
import { getTagsBySession, getTagsByNumbers } from "../../src/features/magic-context/storage-tags";
import { Database } from "../../src/shared/sqlite";

const seed = resolve(process.argv[2] ?? "");
if (!seed.startsWith(`${resolve(join(tmpdir(), "magic-context"))}/`)) throw new Error("Only an isolated store copy is permitted");
const db = new Database(`file:${seed}?immutable=1`, { readonly: true });
const frozenNow = Number(process.env.MEM_AUDIT_NOW ?? Date.now());
Date.now = () => frozenNow;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const samples: Record<string, unknown> = {};
// Measure a byte-neutral norm-reuse experiment without installing it in search.
function prepareQuery(a: Float32Array): (b: Float32Array) => number {
    let normA = 0;
    for (let i = 0; i < a.length; i++) normA += a[i] * a[i];
    const magnitudeA = Math.sqrt(normA);
    return b => {
        if (a.length !== b.length) return 0;
        let dot = 0, normB = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normB += b[i] * b[i]; }
        const denominator = magnitudeA * Math.sqrt(normB);
        return denominator === 0 ? 0 : dot / denominator;
    };
}
async function measure(name: string, operation: () => unknown | Promise<unknown>, repeats = 11) {
    const values: number[] = [];
    for (let i = 0; i < repeats + 1; i++) {
        const start = performance.now();
        await operation();
        if (i > 0) values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    samples[name] = { medianMs: values[Math.floor(values.length / 2)], p90Ms: values[Math.ceil(values.length * .9) - 1], samples: repeats };
}
try {
    const project = db.prepare("SELECT project_path FROM memories GROUP BY project_path ORDER BY COUNT(*) DESC LIMIT 1").get() as { project_path: string };
    const session = db.prepare("SELECT session_id, COUNT(*) AS n FROM tags GROUP BY session_id ORDER BY n DESC LIMIT 1").get() as { session_id: string; n: number };
    const memories = getMemoriesByProject(db, project.project_path);
    const ids = memories.map(m => m.id);
    const model = db.prepare("SELECT model_id FROM memory_embeddings GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1").get() as { model_id: string } | undefined;
    const commitModel = db.prepare("SELECT model_id FROM git_commit_embeddings GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1").get() as { model_id: string } | undefined;
    const commitProject = db.prepare("SELECT project_path FROM git_commits GROUP BY project_path ORDER BY COUNT(*) DESC LIMIT 1").get() as { project_path: string } | undefined;
    const modelId = model?.model_id ?? "off";
    const vectors = getProjectEmbeddings(db, project.project_path, modelId);
    const vector = vectors.values().next().value?.embedding ?? null;
    const commitVectors = commitProject && commitModel ? loadProjectCommitEmbeddings(db, commitProject.project_path, commitModel.model_id) : new Map<string, Float32Array>();
    const commitVector = commitVectors.values().next().value ?? null;
    const inventory = db.prepare(`SELECT (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM message_fts_rowid_map) AS messages, (SELECT COUNT(*) FROM git_commits) AS commits`).get();
    await measure("MEM-1 full memory load", () => getMemoriesByProject(db, project.project_path));
    await measure("MEM-1 cold embedding load", () => { resetEmbeddingCacheForTests(); return getProjectEmbeddings(db, project.project_path, modelId); });
    const cosinePass = (prepared: boolean) => {
        if (!vector) return 0;
        const score = prepared ? prepareQuery(vector) : (value: Float32Array) => cosine.cosineSimilarity(vector, value);
        let sum = 0;
        for (const value of vectors.values()) sum += score(value.embedding);
        return sum;
    };
    await measure("MEM-1 cosine pool", () => cosinePass(false));
    await measure("MEM-1 prepared query-norm experiment", () => cosinePass(true));
    if (!Object.is(cosinePass(true), cosinePass(false))) throw new Error('Cosine pool checksum changed');
    samples['MEM-1 vector dimension'] = vector?.length ?? 0;
    if (commitProject && commitModel) {
        await measure("MEM-2 commit vector load", () => loadProjectCommitEmbeddings(db, commitProject.project_path, commitModel.model_id));
        await measure("MEM-2 commit semantic search", () => searchGitCommitsSync(db, commitProject.project_path, "cache", { limit: 10, queryEmbedding: commitVector, queryModelId: commitModel.model_id }));
    }
    await measure("MEM-3 missing memory submission preparation", () => memories.filter(m => !vectors.has(m.id)).map(m => m.content));
    const muralSnapshot = () => { const pool = mural.readMuralPool?.(db, project.project_path); return [getMuralCoverage(db, project.project_path, pool), resolveMural(db, project.project_path, undefined, pool)]; };
    await measure("MEM-5 mural coverage and resolve", muralSnapshot);
    await measure("MEM-5 reference refresh (two loads)", () => [getMuralCoverage(db, project.project_path), resolveMural(db, project.project_path)]);
    samples['MEM-5 coverage and ordered entries hash'] = hash(muralSnapshot());
    await measure("MEM-9 full session tags", () => getTagsBySession(db, session.session_id));
    const requestedTags = getTagsBySession(db, session.session_id).slice(-5).map(t => t.tagNumber);
    await measure("MEM-9 requested tags", () => getTagsByNumbers(db, session.session_id, requestedTags));
    await measure("MEM-10 complete sidebar backlog", () => getDreamTaskBacklogs(db, project.project_path));
    samples['MEM-10 backlog hash'] = hash(getDreamTaskBacklogs(db, project.project_path));
    for (const task of CANONICAL_DREAM_TASKS) await measure(`MEM-10 ${task}`, () => getDreamTaskBacklog(db, project.project_path, task));
    samples['MEM-10 expiring active rows'] = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_path = ? AND status IN ('active', 'permanent') AND expires_at IS NOT NULL").get(project.project_path);
    await measure("MEM-11 workspace FTS", () => searchMemoriesFTSUnion(db, [project.project_path], "cache", 30));
    await measure("MEM-11 table_info only", () => db.prepare("PRAGMA table_info(memories)").all());
    await measure("MEM-12 cue IN-list", () => getMuralCueState(db, ids));
    await measure("MEM-12 verification IN-list", () => getMemoryVerifications(db, ids));
    await measure("MEM-12 classification IN-list", () => getUnclassifiedMemoryIds(db, ids));
    for (const size of [1000, 10000, 60000]) {
        const largeIds = Array.from({ length: size }, (_, i) => i + 1);
        await measure(`MEM-12 ${size} cue ids`, () => getMuralCueState(db, largeIds), 5);
        await measure(`MEM-12 ${size} verification ids`, () => getMemoryVerifications(db, largeIds), 5);
        await measure(`MEM-12 ${size} classification ids`, () => getUnclassifiedMemoryIds(db, largeIds), 5);
    }
    samples['MEM-12 SQLite bound'] = db.prepare("SELECT compile_options FROM pragma_compile_options WHERE compile_options LIKE 'MAX_VARIABLE_NUMBER=%'").get();
    const list = () => memoryStorage.getMemoriesForList?.(db, project.project_path, ['ARCHITECTURE'], 10) ?? getMemoriesByProject(db, project.project_path).filter(m => m.category === 'ARCHITECTURE').slice(0, 10);
    await measure("MEM-13 list ten architecture memories", list);
    samples['MEM-13 ordered list hash'] = hash(list());
    await measure("MEM-15 boolean list gates", () => ["evaluate-smart-notes", "review-user-memories", "refresh-primers"].map(task => evaluateTaskGate(task as Parameters<typeof evaluateTaskGate>[0], { db, projectIdentity: project.project_path, lastRunAt: null, promotionThreshold: 3 })));
    const cueStates = getMuralCueState(db, ids);
    await measure("MEM-17 compress-cues selection", () => memories.filter(m => memoryNeedsCue(cueStates.get(m.id), m.content)).map(m => computeCueContentHash(m.content)));
    const queries = ["cache", "dreamer", "embedding", "context", "ctx_reduce", "git", "mural", "sqlite", "FTS", "memory"];
    const comparisons: Record<string, unknown> = {};
    for (const query of queries) {
        const results = await unifiedSearch(db, session.session_id, project.project_path, query, {
            embeddingEnabled: true, isEmbeddingRuntimeEnabled: () => true, embedQuery: async () => vector,
            embeddingModelIdOverride: modelId, gitCommitsEnabled: true, countRetrievals: false,
            measurementDisabled: true, explicitSearch: true,
        });
        comparisons[query] = { rows: results.length, orderedRowsHash: hash(results), servedTextHash: hash(formatSearchResults(query, results, session.session_id)) };
    }
    const repo = mkdtempSync(join(tmpdir(), "magic-context/perf-mem/git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-04T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-04T00:00:00Z' } }).trim();
    try {
        git("init", "-q"); git("config", "user.email", "perf@example.invalid"); git("config", "user.name", "Perf");
        const files = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
        for (const file of files) writeFileSync(join(repo, file), "old\n");
        git("add", "."); git("commit", "-qm", "base");
        const base = git("rev-parse", "HEAD");
        const at = Number(git("show", "-s", "--format=%ct")) * 1000 + 1000;
        for (const file of files) writeFileSync(join(repo, file), "new\n");
        const claims = files.map((file, i) => ({ id: i, category: "ARCHITECTURE", content: "claim", mappedFiles: [file], verifiedAt: at }));
        await measure("MEM-6 50 memory 50 file timestamp diff", () => buildVerifyDiffEvidence(repo, claims), 3);
        await measure("MEM-7 normalize 50 tracked paths", () => normalizeVerificationFiles({ cwd: repo, files }), 3);
        await measure("MEM-8 incremental git probes", async () => { const root = (await resolveGitTopLevel(repo)) ?? repo; await readGitFileChangeTimesSince(repo, at, root); await readGitChangedFilesSince(repo, base, root); }, 3);
        samples.gitFixture = { files: 50, claims: 50, evidenceHash: hash(await buildVerifyDiffEvidence(repo, claims)) };
    } finally { rmSync(repo, { recursive: true, force: true }); }
    const triggerDb = new Database(":memory:");
    try {
        triggerDb.exec("CREATE VIRTUAL TABLE git_commits_fts USING fts5(sha UNINDEXED, project_path UNINDEXED, message)");
        const insert = triggerDb.prepare("INSERT INTO git_commits_fts(sha, project_path, message) VALUES (?, 'project', 'cache change')");
        triggerDb.transaction(() => { for (let i = 0; i < 2000; i++) insert.run(String(i)); })();
        const remove = triggerDb.prepare("DELETE FROM git_commits_fts WHERE sha = ?");
        await measure("MEM-4 2000 pre-insert deletes against 2000 rows", () => triggerDb.transaction(() => { for (let i = 0; i < 2000; i++) remove.run(`absent${i}`); })(), 3);
        samples["MEM-4 plan"] = triggerDb.prepare("EXPLAIN QUERY PLAN DELETE FROM git_commits_fts WHERE sha = ?").all("absent");
    } finally { triggerDb.close(); }
    samples.inventory = { total: inventory, selectedLiveMemories: memories.length, storedVectors: vectors.size, missingVectors: memories.filter(m => !vectors.has(m.id)).length, commitVectors: commitVectors.size, selectedSessionTags: session.n };
    samples.comparisons = comparisons;
    const commitComparisons: Record<string, unknown> = {};
    if (commitProject && commitModel) for (const query of queries) {
        for (const dated of [false, true]) {
            const results = searchGitCommitsSync(db, commitProject.project_path, query, { limit: 30, queryEmbedding: commitVector, queryModelId: commitModel.model_id, ...(dated ? { to: frozenNow - 86400000 } : {}) });
            commitComparisons[`${query}:${dated}`] = { rows: results.length, orderedRowsHash: hash(results) };
        }
    }
    samples.commitComparisons = commitComparisons;
    // Check open descriptors while the immutable seed is still open; never dump corpus contents.
    const descriptors = execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf8", timeout: 10_000 }).split("\n").filter(line => /\.db(?:\s|$)/.test(line));
    samples.databaseDescriptors = descriptors;
    console.log(JSON.stringify({ bun: Bun.version, frozenNow, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), samples }, null, 2));
} finally { db.close(); }
