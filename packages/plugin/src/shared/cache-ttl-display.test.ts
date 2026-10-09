import { describe, expect, it } from "bun:test";

import { initializeDatabase } from "../features/magic-context/storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage-meta";
import { resolveCacheTtlDisplay } from "./cache-ttl-display";
import { seedSessionCacheTtlIfUnsynced } from "./cache-ttl-seed";
import { Database } from "./sqlite";

const modelKey = "anthropic/claude-opus-5";

describe("resolveCacheTtlDisplay", () => {
    it("shows config before the first message_end sync", () => {
        expect(
            resolveCacheTtlDisplay({
                configured: { default: "5m", [modelKey]: "1h" },
                configuredExplicitly: true,
                modelKey,
                sessionValue: "5m",
                sessionModelKey: null,
            }),
        ).toEqual({ value: "1h", source: "config", modelKey });
    });

    it("discriminates config, session, and guessed default provenance", () => {
        const configured = resolveCacheTtlDisplay({
            configured: "1h",
            configuredExplicitly: true,
            modelKey,
            sessionValue: "5m",
            sessionModelKey: null,
        });
        const session = resolveCacheTtlDisplay({
            configured: "1h",
            configuredExplicitly: true,
            modelKey,
            sessionValue: "45m",
            sessionModelKey: modelKey,
        });
        const fallback = resolveCacheTtlDisplay({
            configured: "5m",
            configuredExplicitly: false,
            modelKey,
            sessionValue: "5m",
            sessionModelKey: null,
        });

        expect(configured.source).toBe("config");
        expect(session).toEqual({ value: "1h", source: "config", modelKey });
        expect(fallback).toEqual({ value: "5m", source: "default", modelKey });
    });

    it("seeds only an unsynced row and leaves a scheduler-owned row unchanged", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        try {
            expect(
                seedSessionCacheTtlIfUnsynced({
                    db,
                    sessionId: "ses-seed",
                    configured: { default: "5m", [modelKey]: "1h" },
                    modelKey,
                }),
            ).toBe(true);
            expect(getOrCreateSessionMeta(db, "ses-seed").cacheTtl).toBe("1h");

            updateSessionMeta(db, "ses-seed", {
                cacheTtl: "45m",
                lastObservedModelKey: modelKey,
                lastResponseTime: 1,
            });
            expect(
                seedSessionCacheTtlIfUnsynced({
                    db,
                    sessionId: "ses-seed",
                    configured: "2h",
                    modelKey,
                }),
            ).toBe(false);
            expect(getOrCreateSessionMeta(db, "ses-seed").cacheTtl).toBe("45m");
        } finally {
            db.close();
        }
    });
});
