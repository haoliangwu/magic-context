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

it("applies user TTL edits across config changes and restart, with truthful status provenance", () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-ttl-policy-"));
    const path = join(root, "context.db");
    let db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
        expect(resolveSessionCacheTtl(db, "session", "5m", undefined).value).toBe("5m");
        expect(resolveSessionCacheTtl(db, "session", "1h", "openai/gpt-6", true).value).toBe("1h");
        db.close();
        db = new Database(path);
        expect(resolveSessionCacheTtl(db, "session", "13h", "openai/gpt-6", true).value).toBe(
            "13h",
        );
        expect(getOrCreateSessionMeta(db, "session").cacheTtl).toBe("13h");
        const display = resolveCacheTtlDisplay({
            frozen: readSessionCacheTtl(db, "session"),
            configured: "13h",
            configuredExplicitly: true,
            modelKey: "openai/gpt-6",
            sessionValue: "13h",
            sessionModelKey: "openai/gpt-6",
        });
        expect(formatCacheTtlDisplay(display)).toBe("Cache TTL: 13h (your config)");
        expect(resolveSessionCacheTtl(db, "session", "1m", "other/unknown", true).value).toBe("1m");
    } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});

it("freezes only built-in defaults and honors explicit 5m and map defaults", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    try {
        const model = "other/model";
        expect(resolveSessionCacheTtl(db, "built-in", "5m", model, false).value).toBe("5m");
        expect(resolveSessionCacheTtl(db, "built-in", "10m", model, false)).toMatchObject({
            value: "5m",
            source: "default",
        });
        expect(formatCacheTtlDisplay(readSessionCacheTtl(db, "built-in")!)).toBe(
            "Cache TTL: 5m (built-in default, frozen for this session)",
        );
        expect(resolveSessionCacheTtl(db, "built-in", "1h", model, true).value).toBe("1h");
        expect(resolveSessionCacheTtl(db, "built-in", "10m", model, false).value).toBe("5m");
        expect(
            resolveSessionCacheTtl(db, "map", { default: "1h" }, "openai/gpt-6", true).value,
        ).toBe("1h");
        expect(
            resolveSessionCacheTtl(db, "map", { default: "13h" }, "openai/gpt-6", true).value,
        ).toBe("13h");
        expect(resolveSessionCacheTtl(db, "map", "5m", "openai/gpt-6", true)).toMatchObject({
            value: "5m",
            source: "config",
        });
    } finally {
        db.close();
    }
});
