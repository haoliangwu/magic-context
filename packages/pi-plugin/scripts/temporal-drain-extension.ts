import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getTagsBySession, openDatabase, queuePendingOp, setPendingPiCompactionMarkerState, updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { registerPiContextHandler, signalPiDeferredHistoryRefresh, signalPiDeferredMaterialization } from "../src/context-handler";
import { temporalLegacyTree } from "./temporal-legacy-tree";

/** Exercise the production context handler inside Pi, without unrelated background agents. */
export default async function temporalDrainExtension(pi: ExtensionAPI) {
    const root = process.env.MC_TEMPORAL_ROOT;
    if (!root) throw new Error("MC_TEMPORAL_ROOT must name the isolated probe root");
    const legacyTree = process.env.MC_TEMPORAL_LEGACY === "1" ? temporalLegacyTree(process.env.MC_TEMPORAL_REPO) : undefined;
    const storage = legacyTree ? await import(join(legacyTree, "packages/plugin/src/features/magic-context/storage.ts")) : { openDatabase };
    const db = storage.openDatabase(join(root, "storage/context.db"));
    if (!db) throw new Error("Probe database unavailable");
    let pass = Number(process.env.MC_TEMPORAL_START_PASS ?? 0);
    pi.on("context", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const ids = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id);
        if (++pass === 1) {
            appendCompartments(db, sessionId, [{ sequence: 0, startMessage: 1, endMessage: 255, startMessageId: ids[0]!, endMessageId: ids[254]!, title: "Baseline", content: "Previously folded history." }]);
            updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
        } else if (pass === 2) {
            for (const tag of getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool").slice(0, 11)) queuePendingOp(db, sessionId, tag.tagNumber, "drop", Date.now());
            appendCompartments(db, sessionId, [{ sequence: 1, startMessage: 256, endMessage: 307, startMessageId: ids[255]!, endMessageId: ids[306]!, title: "Publication", content: `Newly folded history ${"c".repeat(2450)}` }]);
            setPendingPiCompactionMarkerState(db, sessionId, { firstKeptEntryId: ids[307]!, endMessageId: ids[306]!, ordinal: 307, tokensBefore: 20_000, summary: "Magic Context marker projection", publishedAt: Date.now() });
            signalPiDeferredHistoryRefresh(sessionId);
            signalPiDeferredMaterialization(sessionId);
            updateSessionMeta(db, sessionId, { lastResponseTime: Date.now(), cacheTtl: "59m", lastContextPercentage: 70, lastInputTokens: 70_000 });
        } else {
            updateSessionMeta(db, sessionId, { lastResponseTime: Date.now(), cacheTtl: "59m", lastContextPercentage: 10, lastInputTokens: 10_000 });
        }
    });
    const register = legacyTree
        ? (await import(join(legacyTree, "packages/pi-plugin/src/context-handler.ts"))).registerPiContextHandler
        : registerPiContextHandler;
    register(pi, { db, protectedTags: 0, scheduler: { executeThresholdPercentage: 65 }, injection: { injectionBudgetTokens: 10_000, memoryEnabled: false, injectDocs: false, temporalAwareness: true } });
}
