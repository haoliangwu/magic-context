/** Provider-boundary probes: synthetic histories and a counting embedder, no host services. */
import { execFileSync } from 'node:child_process';
import { ensureMemoryEmbeddings } from "../../src/features/magic-context/memory/embedding-backfill";
import type { EmbeddingProvider } from "../../src/features/magic-context/memory/embedding-provider";
import type { Memory } from "../../src/features/magic-context/memory/types";
import { getUnclassifiedMemoryIds } from '../../src/features/magic-context/memory/storage-memory';
import { getMemoryVerifications, getUnmappedMemoryIds } from '../../src/features/magic-context/memory/storage-memory-verifications';
import { getMuralCueState } from '../../src/features/magic-context/mural/storage-mural-cues';
import { _resetProjectEmbeddingRegistryForTests, _setTestProviderFactoryForProject, embedTextForProject, registerProjectEmbedding } from "../../src/features/magic-context/project-embedding-registry";
import { runMigrations } from "../../src/features/magic-context/migrations";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { setRawMessageProvider } from "../../src/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../src/hooks/magic-context/read-session-raw";
import { Database } from "../../src/shared/sqlite";
import { renderItemByTag } from "../../src/tools/ctx-expand/render";

const db = new Database(":memory:");
const results: Record<string, unknown> = {};
try {
    initializeDatabase(db);
    runMigrations(db);
    db.prepare("INSERT INTO tags (message_id, type, status, byte_size, session_id, tag_number, tool_owner_message_id) VALUES ('call', 'tool', 'active', 20, 'perf-pi', 1, 'owner')").run();
    for (const size of [1000, 10000, 60000]) {
        const messages: RawMessage[] = Array.from({ length: size }, (_, i) => ({ ordinal: i + 1, id: `msg${i}`, role: 'user', parts: [{ type: 'text', text: 'stored history '.repeat(20) }] }));
        const owner = messages[size - 3];
        owner.id = 'owner';
        owner.role = 'assistant';
        owner.parts = [{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'file.ts' } }];
        messages[size - 2].parts = [{ type: 'tool_result', tool_use_id: 'call', content: 'file contents' }];
        const serialized = JSON.stringify(messages);
        let reads = 0;
        const release = setRawMessageProvider('perf-pi', {
            readMessages: () => { reads += size; return JSON.parse(serialized) as RawMessage[]; },
            readMessageById: id => id === 'owner' ? owner : null,
            *iterateMessageRange(from, to) { for (let i = from - 1; i < Math.min(size, to); i++) { reads++; yield messages[i]; } },
        });
        try {
            const times: number[] = [];
            let text = '';
            for (let i = 0; i < 6; i++) {
                const start = performance.now();
                text = renderItemByTag(db, 'perf-pi', 1);
                if (i > 0) times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            if (!text.includes('file contents') || reads === 0) throw new Error('Pi result lane was not reached');
            results[`MEM-14 ${size} messages`] = { medianMs: times[2], rowsReadPerCall: reads / 6, text, samples: 5 };
        } finally { release(); }
    }
    const batches: number[] = [];
    let queries = 0;
    const provider: EmbeddingProvider = {
        modelId: 'perf-model', initialize: async () => true, dispose: async () => {}, isLoaded: () => true,
        embed: async () => { queries++; return new Float32Array([1, 2]); },
        embedBatch: async texts => { batches.push(texts.length); return texts.map(() => null); },
    };
    _setTestProviderFactoryForProject(() => provider);
    registerProjectEmbedding(db, 'git:perf', { provider: 'local', model: 'perf-model', local_runtime: 'auto' }, { memoryEnabled: true, gitCommitEnabled: false }, '/isolated/perf');
    for (const size of [1000, 10000, 60000]) {
        const memories = Array.from({ length: size }, (_, i) => ({ id: i + 1, content: `claim ${i}`, normalizedHash: 'not-a-stored-row' }) as Memory);
        const start = performance.now();
        for (let i = 0; i < 2; i++) await ensureMemoryEmbeddings({ db, projectIdentity: 'git:perf', memories, existingEmbeddings: new Map() });
        results[`MEM-3 ${size} missing vectors`] = { msTwoPasses: performance.now() - start, submittedBatchSizes: batches.splice(0), provider: 'zero-latency null-vector counting control' };
    }
    const start = performance.now();
    for (let i = 0; i < 10; i++) await embedTextForProject('git:perf', 'cache', undefined, 'query');
    results['MEM-16 ten identical queries'] = { ms: performance.now() - start, providerCalls: queries, provider: 'zero-latency counting control; excludes model/network cost' };
    const ids = Array.from({ length: 60000 }, (_, i) => i + 1);
    let unbounded = '';
    try { db.prepare(`SELECT id FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids); }
    catch (error) { unbounded = String(error); }
    const idStart = performance.now();
    const sideTableRows = [getMuralCueState(db, ids).size, getMemoryVerifications(db, ids).size, getUnclassifiedMemoryIds(db, ids).length, getUnmappedMemoryIds(db, ids).length];
    results['MEM-12 60k-id bound'] = { oldUnboundedError: unbounded, ms: performance.now() - idStart, sideTableRows };
    results['MEM-12 Node SQLite bound'] = JSON.parse(execFileSync('node', ['--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE ids(id INTEGER PRIMARY KEY); INSERT INTO ids VALUES (1), (60000)');
        const ids = Array.from({ length: 60000 }, (_, i) => i + 1);
        const bound = db.prepare("SELECT compile_options FROM pragma_compile_options WHERE compile_options LIKE 'MAX_VARIABLE_NUMBER=%'").get();
        let error = '';
        try { db.prepare('SELECT id FROM ids WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids); }
        catch (failure) { error = String(failure); }
        const rows = db.prepare('SELECT id FROM ids WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
        console.log(JSON.stringify({ node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS version').get(), bound, oldUnboundedError: error, jsonRows: rows }));
        db.close();
    `], { encoding: 'utf8', timeout: 10000, windowsHide: true }));
    console.log(JSON.stringify({ bun: Bun.version, results }, null, 2));
} finally { _resetProjectEmbeddingRegistryForTests(); db.close(); }
