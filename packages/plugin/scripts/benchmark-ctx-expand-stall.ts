import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/shared/sqlite';
import { contextStore, hostStore, SESSION } from '../src/features/magic-context/__tests__/host-stalls.fixture';
import { withMessageFtsSessionFilter } from '../src/features/magic-context/message-fts-session-filter';
import { startMessageFtsRowidMapBackfill } from '../src/features/magic-context/message-fts-rowid-map';
import { renderSearchArchive, renderSearchArchiveOffThread } from '../src/tools/ctx-expand/search-archive';
import { readRawSessionMessageIdOrdinalsForRangeFromDb } from '../src/hooks/magic-context/read-session-raw';
import { closeReadOnlySessionDb } from '../src/hooks/magic-context/read-session-db';
import { estimateTokens } from '../src/hooks/magic-context/read-session-formatting';

const root = mkdtempSync(join(tmpdir(), 'ctx-expand-scale-'));
const rawPath = join(root, 'opencode.db');
const db = contextStore(join(root, 'context.db'));
const raw = hostStore(rawPath, 175000);
raw.prepare('UPDATE message SET data=?').run(JSON.stringify({
    role: 'user', providerID: 'fixture-provider', modelID: 'fixture-model',
    time: {created: 0, completed: 1}, tokens: {input: 1024, output: 64, cache: {read: 768, write: 0}},
    fixtureMetadata: 'synthetic message metadata '.repeat(40),
}));
const old = process.env.OPENCODE_DB;
process.env.OPENCODE_DB = rawPath;
const output: unknown[] = [];
async function measure(name: string, run: () => unknown | Promise<unknown>) {
    let maxLag = 0;
    let ticks = 0;
    let last = performance.now();
    const probe = setInterval(() => {
        const now = performance.now();
        maxLag = Math.max(maxLag, now - last - 1);
        last = now;
        ticks++;
    }, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    const began = performance.now();
    const result = await run();
    const elapsedMs = performance.now() - began;
    await new Promise(resolve => setTimeout(resolve, 10));
    clearInterval(probe);
    output.push({ name, elapsedMs, maxLagMs: maxLag, ticks });
    return result;
}
try {
    const padding = ' archive fixture content '.repeat(24);
    const insert = db.prepare('INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,?,?)');
    db.transaction(() => {
        for (let s = 0; s < 200; s++) {
            for (let n = 1; n <= 600; n++) {
                insert.run(`session-${s}`, n, `s${s}-${n}`, 'user', `${padding}${s}:${n}`);
                const row = db.prepare('SELECT last_insert_rowid() AS id').get() as {id:number};
                db.prepare('INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid) VALUES(?,?,?)').run(`session-${s}`, n, row.id);
            }
        }
        for (let n = 1; n <= 175000; n++) insert.run(SESSION, n, `pruned-${n}`, 'user', `${padding}${n}`);
    }).immediate();
    // Clearing the backfill state makes startup mapping scan from the first FTS row.
    db.exec('DELETE FROM message_fts_rowid_map_backfill_state');
    estimateTokens('warm tokenizer');
    output.push({ bun: Bun.version, fixture: {ftsRows:295000, sessions:201, rawMessages:175000, contextBytes:statSync(join(root,'context.db')).size, rawBytes:statSync(rawPath).size}});
    const coverageSql = `SELECT DISTINCT session_id AS sessionId FROM message_history_fts WHERE rowid IN (SELECT id FROM message_history_fts_docsize EXCEPT SELECT fts_rowid FROM message_fts_rowid_map)`;
    await measure('coverage.missing.all cold', () => db.prepare(coverageSql).all());
    await measure('coverage.missing.all warm', () => db.prepare(coverageSql).all());
    output.push({ legacySessionFirst:withMessageFtsSessionFilter(db,SESSION,value=>value), legacyPlan:db.prepare('EXPLAIN QUERY PLAN SELECT * FROM message_history_fts WHERE session_id=? AND message_ordinal BETWEEN ? AND ? ORDER BY CAST(message_ordinal AS INTEGER)').all(SESSION,174998,175000) });
    await measure('legacy FTS iterate only', () => [...db.prepare('SELECT message_ordinal,message_id,role,content FROM message_history_fts WHERE session_id=? AND message_ordinal BETWEEN ? AND ? ORDER BY CAST(message_ordinal AS INTEGER)').iterate(SESSION,174998,175000)]);
    for (const end of [3, 87500, 175000]) {
        await measure(`raw exact ordinal range ending ${end}`, () => readRawSessionMessageIdOrdinalsForRangeFromDb(raw,SESSION,end-2,end));
    }
    const before = await measure('before legacy archive synchronous cold coverage', () => {
        const connection = new Database(join(root,'context.db'));
        try { return renderSearchArchive(connection,SESSION,174998,175000,15000); } finally { connection.close(); }
    });
    const after = await measure('after legacy archive worker', () => renderSearchArchiveOffThread(db,SESSION,174998,175000,15000));
    if (before !== after) throw new Error('legacy output differs');
    await measure('bounded startup backfill worker outside search', () => startMessageFtsRowidMapBackfill(db));
    output.push({ backfilledSessionFirst: withMessageFtsSessionFilter(db,SESSION,value=>value), mappedPlan:db.prepare('EXPLAIN QUERY PLAN SELECT f.content FROM message_fts_rowid_map m JOIN message_history_fts f ON f.rowid=m.fts_rowid WHERE m.session_id=? AND m.message_ordinal BETWEEN ? AND ? ORDER BY m.message_ordinal').all(SESSION,174998,175000) });
    const mappedBefore = await measure('before mapped archive synchronous cold coverage', () => {
        const connection = new Database(join(root,'context.db'));
        try { return renderSearchArchive(connection,SESSION,174998,175000,15000); } finally { connection.close(); }
    });
    const mappedAfter = await measure('after mapped archive worker', () => renderSearchArchiveOffThread(db,SESSION,174998,175000,15000));
    if (mappedBefore !== mappedAfter || before !== mappedAfter) throw new Error('mapped output differs');
    console.log(JSON.stringify(output,null,2));
} finally {
    closeReadOnlySessionDb();
    if (old === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB=old;
    db.close(); raw.close(); rmSync(root,{recursive:true,force:true});
}
