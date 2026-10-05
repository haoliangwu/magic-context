import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import { projectLkgEntry, createLkgEntryProjector } from "../src/hooks/magic-context/lkg-replay";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import { getMuralCoverage, resolveMural } from "../src/features/magic-context/mural/resolve-mural";
import { renderMural, planMuralRender, rasterMural, encodeMuralPng } from "../src/features/magic-context/mural/render-mural";
import { ensureMuralRendered, muralCoverageGate } from "../src/features/magic-context/mural/render-trigger";
import { getMural } from "../src/features/magic-context/mural/storage-mural";

// Restrict database reads and writes to a temporary directory containing APFS
// clones. Never supply a live store: the mural benchmark may update its manifest.
const root = realpathSync(process.argv[2]!);
assert(root.startsWith(`${realpathSync(join(tmpdir(), "magic-context"))}/`));
for (const path of ["oc/opencode.db", "mc/context.db"]) assert(realpathSync(join(root, path)).startsWith(`${root}/`));
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "probe.log");
const host = new Database(join(root, "oc/opencode.db"));
const db = new Database(join(root, "mc/context.db"));
const sessions = process.argv.slice(3);
const projectEntry = createLkgEntryProjector();
const optimized = process.env.PERF_OPTIMIZED === "1";
const measure = <T>(fn: () => T) => {
    const start = performance.now();
    const value = fn();
    return { ms: performance.now() - start, value };
};
for (const sessionId of sessions) {
    const rows = host.prepare("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(sessionId) as { id: string; data: string }[];
    // OpenCode omits history before a user compaction message once its assistant
    // summary has completed. Reproduce that visible request boundary.
    let start = 0;
    const completed = new Set<string>();
    for (let index = rows.length - 1; index >= 0; index--) {
        const info = JSON.parse(rows[index]!.data);
        if (info.role === "assistant" && info.summary && info.finish && !info.error) completed.add(info.parentID);
        if (info.role === "user" && completed.has(rows[index]!.id)) {
            const parts = host.prepare("SELECT data FROM part WHERE message_id=?").all(rows[index]!.id) as { data: string }[];
            if (parts.some((part) => JSON.parse(part.data).type === "compaction")) { start = index; break; }
        }
    }
    const messages: MessageLike[] = rows.slice(start).map((row) => ({
        info: { ...JSON.parse(row.data), id: row.id, sessionID: sessionId },
        parts: (host.prepare("SELECT id,data FROM part WHERE message_id=? ORDER BY id").all(row.id) as { id: string; data: string }[]).map((part) => ({ ...JSON.parse(part.data), id: part.id, messageID: row.id, sessionID: sessionId })),
    }));
    const directory = (host.prepare("SELECT directory FROM session WHERE id=?").get(sessionId) as { directory: string }).directory;
    const project = (db.prepare("SELECT project_path FROM session_projects WHERE session_id=? LIMIT 1").get(sessionId) as { project_path: string } | null)?.project_path ?? directory;
    console.error(`loaded ${messages.length} messages for ${sessionId}, project=${project}`);
    const results = [];
    for (let pass = 0; pass < 6; pass++) {
        const wire = structuredClone(messages);
        const projection = measure(() => optimized ? projectEntry(sessionId, wire) : projectLkgEntry(wire));
        const rustProjection = optimized ? measure(() => []) : { ms: projection.ms };
        if (optimized) assert.deepEqual(projection.value.map((p) => p.contentDigest?.()), projectLkgEntry(wire).map((p) => p.contentDigest?.()));
        const coverage = measure(() => getMuralCoverage(db, project));
        const entries = measure(() => resolveMural(db, project, 4000));
        const plan = measure(() => planMuralRender(entries.value));
        const raster = measure(() => rasterMural(plan.value));
        const png = measure(() => encodeMuralPng(raster.value, plan.value.width, plan.value.height));
        const render = measure(() => renderMural(entries.value));
        const mural = measure(() => {
            if (optimized) return ensureMuralRendered(db, project, 4000);
            const currentCoverage = getMuralCoverage(db, project);
            if (!currentCoverage.activeMemoryCount || !muralCoverageGate(currentCoverage.cuedMemoryCount, currentCoverage.activeMemoryCount)) return { hasMural: false };
            const pool = resolveMural(db, project, 4000);
            if (!pool.length) return { hasMural: false };
            // Reproduce the pre-optimization render-before-compare cost, including
            // the stored PNG's base64 conversion when text and dimensions match.
            const full = renderMural(pool);
            const textHash = createHash("sha256").update(full.sha256Input).digest("hex");
            const existing = getMural(db, project);
            return { hasMural: true, contentHash: textHash, dataUrl: existing?.contentHash === textHash && existing.width === full.width && existing.height === full.height ? `data:image/png;base64,${existing.image.toString("base64")}` : full.dataUrl };
        });
        if (mural.value.hasMural) {
            assert.equal(mural.value.dataUrl, render.value.dataUrl);
            assert.equal(mural.value.contentHash, createHash("sha256").update(render.value.sha256Input).digest("hex"));
        }
        const stored = getMural(db, project);
        const base64 = measure(() => stored?.image.toString("base64"));
        results.push({ pass, projectionMs: projection.ms, rustProjectionMs: rustProjection.ms, coverageMs: coverage.ms, resolveMs: entries.ms, renderMs: render.ms, layoutMs: plan.ms, rasterMs: raster.ms, pngMs: png.ms, muralMs: mural.ms, base64Ms: base64.ms, entries: entries.value.length, digestHash: createHash("sha256").update(JSON.stringify(projection.value.map((p) => p.contentDigest?.()))).digest("hex"), muralHash: mural.value.contentHash, pngHash: createHash("sha256").update(render.value.png).digest("hex") });
    }
    console.log(JSON.stringify({ sessionId, directory, project, messages: messages.length, results }));
}
host.close();
db.close();
