import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCacheTtlDisplay, resolveCacheTtlDisplay } from "../../shared/cache-ttl-display";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { readSessionCacheTtl, resolveSessionCacheTtl } from "./session-cache-ttl";
import { initializeDatabase } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta";

it("freezes TTL policy across config changes and restart, with truthful status provenance", () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-ttl-policy-"));
    const path = join(root, "context.db");
    let db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
        expect(resolveSessionCacheTtl(db, "session", "5m", undefined).value).toBe("5m");
        expect(resolveSessionCacheTtl(db, "session", "5m", "openai/gpt-6").value).toBe("30m");
        db.close();
        db = new Database(path);
        expect(resolveSessionCacheTtl(db, "session", "1m", "openai/gpt-6").value).toBe("30m");
        expect(getOrCreateSessionMeta(db, "session").cacheTtl).toBe("30m");
        const display = resolveCacheTtlDisplay({
            frozen: readSessionCacheTtl(db, "session"),
            configured: "1m",
            configuredExplicitly: true,
            modelKey: "openai/gpt-6",
            sessionValue: "30m",
            sessionModelKey: "openai/gpt-6",
        });
        expect(formatCacheTtlDisplay(display)).toBe("Cache TTL: 30m (OpenAI GPT-5.6+ default)");
        // Changing the model invalidates the cache; keep the session's saved 5m policy,
        // rather than adopting the newly supplied 1m config.
        expect(resolveSessionCacheTtl(db, "session", "1m", "other/unknown").value).toBe("5m");
    } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});
