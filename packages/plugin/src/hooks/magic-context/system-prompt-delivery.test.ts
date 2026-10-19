import { afterEach, expect, it } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import type { LkgRequestIdentity } from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import {
    acknowledgeSystemPromptDelivery,
    bindSystemPromptResponse,
    clearSystemPromptDelivery,
    deferDeliveredSystemRefresh,
    recordHeldHeadForRequest,
    recordSystemPromptForRequest,
} from "./system-prompt-delivery";

const sessionId = "delivery-guards";
const databases: Database[] = [];
afterEach(() => {
    clearSystemPromptDelivery(sessionId);
    for (const db of databases.splice(0)) db.close();
});
function prepared(kind: "v1" | "v2" = "v1", held = true) {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cachedM0SystemHash: "old" });
    const request: LkgRequestIdentity =
        kind === "v1"
            ? { kind, responseId: "reply", modelKey: "anthropic/opus" }
            : { kind, previousResponseId: "previous", startedAt: 100, modelKey: "anthropic/opus" };
    recordSystemPromptForRequest(sessionId, request, "sent", db);
    if (held) recordHeldHeadForRequest(sessionId, request);
    if (kind === "v2")
        bindSystemPromptResponse(sessionId, request, {
            responseId: "reply",
            modelKey: "anthropic/opus",
            createdAt: 101,
        });
    const response = {
        sessionId,
        request,
        responseId: "reply",
        modelKey: "anthropic/opus",
        finish: "stop",
        createdAt: 101,
        v2: kind === "v2",
    };
    return { response, hash: () => getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash };
}
it("delivery guard: accepted held request adopts the exact captured hash", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery(f.response);
    expect(f.hash()).toBe("sent");
});
it("delivery guard: an unheld request cannot acknowledge", () => {
    const f = prepared("v1", false);
    acknowledgeSystemPromptDelivery(f.response);
    expect(f.hash()).toBe("old");
});
it("delivery guard: a replaced request cannot acknowledge", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, request: { ...f.response.request } });
    expect(f.hash()).toBe("old");
});
it("delivery guard: another model cannot acknowledge", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, modelKey: "anthropic/other" });
    expect(f.hash()).toBe("old");
});
it("delivery guard: another v1 response cannot acknowledge", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, responseId: "other" });
    expect(f.hash()).toBe("old");
});
it("delivery guard: failure wins over completion", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, error: "aborted", completedAt: 200 });
    expect(f.hash()).toBe("old");
    acknowledgeSystemPromptDelivery(f.response);
    expect(f.hash()).toBe("old");
});
it("delivery guard: a streaming shell is not acceptance", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, finish: undefined });
    expect(f.hash()).toBe("old");
});
it("delivery guard: v2 previous response is not this request", () => {
    const f = prepared("v2");
    acknowledgeSystemPromptDelivery({ ...f.response, responseId: "previous" });
    expect(f.hash()).toBe("old");
});
it("delivery guard: v2 response predating request cannot acknowledge", () => {
    const f = prepared("v2");
    acknowledgeSystemPromptDelivery({ ...f.response, createdAt: 99 });
    expect(f.hash()).toBe("old");
});
it("delivery guard: v2 accepted response acknowledges", () => {
    const f = prepared("v2");
    acknowledgeSystemPromptDelivery(f.response);
    expect(f.hash()).toBe("sent");
});
it("delivery guard: acknowledgement preserves independent flush origin", () => {
    const deps = {
        historyRefreshSessions: new Set([sessionId]),
        pendingMaterializationSessions: new Set<string>(),
        deferredMaterializationSessions: new Set<string>(),
        deferredHistoryRefreshSessions: new Set<string>(),
    };
    requestPendingMaterialization(deps.pendingMaterializationSessions, sessionId, "user_flush");
    deferDeliveredSystemRefresh(deps, sessionId, true);
    expect(deps.pendingMaterializationSessions.has(sessionId)).toBe(true);
    expect(deps.historyRefreshSessions.has(sessionId)).toBe(true);
    expect(deps.deferredMaterializationSessions.has(sessionId)).toBe(false);
});
it("delivery guard: system refresh becomes pending ride-only work, not drained work", () => {
    const deps = {
        historyRefreshSessions: new Set([sessionId]),
        pendingMaterializationSessions: new Set<string>(),
        deferredMaterializationSessions: new Set<string>(),
        deferredHistoryRefreshSessions: new Set<string>(),
    };
    requestPendingMaterialization(deps.pendingMaterializationSessions, sessionId, "system_hash");
    deferDeliveredSystemRefresh(deps, sessionId, true);
    expect(deps.pendingMaterializationSessions.has(sessionId)).toBe(false);
    expect(deps.historyRefreshSessions.has(sessionId)).toBe(false);
    expect(deps.deferredMaterializationSessions.has(sessionId)).toBe(true);
    expect(deps.deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
});

it("delivery guard: pre-existing history refresh is not claimed by system delivery", () => {
    const deps = {
        historyRefreshSessions: new Set([sessionId]),
        pendingMaterializationSessions: new Set<string>(),
        deferredMaterializationSessions: new Set<string>(),
        deferredHistoryRefreshSessions: new Set<string>(),
    };
    requestPendingMaterialization(deps.pendingMaterializationSessions, sessionId, "system_hash");
    deferDeliveredSystemRefresh(deps, sessionId, false);
    expect(deps.historyRefreshSessions.has(sessionId)).toBe(true);
    expect(deps.deferredMaterializationSessions.has(sessionId)).toBe(true);
    expect(deps.deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
});
it("delivery guard: an unknown v2 response creation time cannot acknowledge", () => {
    const f = prepared("v2");
    acknowledgeSystemPromptDelivery({ ...f.response, createdAt: undefined });
    expect(f.hash()).toBe("old");
});
it("delivery guard: v1 identity rejects a v2 response", () => {
    const f = prepared();
    acknowledgeSystemPromptDelivery({ ...f.response, v2: true });
    expect(f.hash()).toBe("old");
});
it("delivery guard: v2 identity rejects a v1 response", () => {
    const f = prepared("v2");
    acknowledgeSystemPromptDelivery({ ...f.response, v2: false });
    expect(f.hash()).toBe("old");
});

it("delivery guard: a flush arriving after the system refresh remains independently active", () => {
    const deps = {
        historyRefreshSessions: new Set([sessionId]),
        pendingMaterializationSessions: new Set<string>(),
        deferredMaterializationSessions: new Set<string>(),
        deferredHistoryRefreshSessions: new Set<string>(),
    };
    requestPendingMaterialization(deps.pendingMaterializationSessions, sessionId, "system_hash");
    requestPendingMaterialization(deps.pendingMaterializationSessions, sessionId, "user_flush");
    deferDeliveredSystemRefresh(deps, sessionId, true);
    expect(deps.pendingMaterializationSessions.has(sessionId)).toBe(true);
    expect(deps.historyRefreshSessions.has(sessionId)).toBe(true);
    expect(deps.deferredMaterializationSessions.has(sessionId)).toBe(false);
});
