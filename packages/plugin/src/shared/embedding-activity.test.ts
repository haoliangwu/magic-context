import { expect, test } from "bun:test";
import { isEmbeddingHostBusy, observeEmbeddingActivity } from "./embedding-activity";

test("background embedding gate tracks all active sessions and releases on idle or deletion", () => {
    const status = (sessionID: string, type: string) =>
        observeEmbeddingActivity({
            type: "session.status",
            properties: { sessionID, status: { type } },
        });
    expect(isEmbeddingHostBusy()).toBe(false);
    status("embedding-gate-a", "busy");
    status("embedding-gate-b", "retry");
    expect(isEmbeddingHostBusy()).toBe(true);
    status("embedding-gate-a", "idle");
    expect(isEmbeddingHostBusy()).toBe(true);
    observeEmbeddingActivity({
        type: "session.deleted",
        properties: { sessionID: "embedding-gate-b" },
    });
    expect(isEmbeddingHostBusy()).toBe(false);
});
