/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import { closeDatabase, insertTag, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { TagTarget } from "./tag-messages";
import { buildSyntheticToolReclaimOps } from "./tool-reclaim";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

function freshDb(): NonNullable<ReturnType<typeof openDatabase>> {
    const dir = createTestTempDirFromPath(join(tmpdir(), "tool-reclaim-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    return db;
}

function target(): TagTarget {
    return {
        setContent: () => true,
        drop: () => "removed",
        canDrop: () => true,
    };
}

describe("buildSyntheticToolReclaimOps", () => {
    it("keeps the newest three ctx_reduce exemplars out of the age lane", () => {
        const db = freshDb();
        const sessionId = "ses-ctx-reduce-age";
        const targets = new Map<number, TagTarget>();
        for (let n = 1; n <= 5; n += 1) {
            insertTag(
                db,
                sessionId,
                `reduce-${n}`,
                "tool",
                4_000,
                n,
                0,
                "ctx_reduce",
                0,
                null,
                null,
                {
                    tokenCount: 1_000,
                    inputTokenCount: 0,
                    reasoningTokenCount: 0,
                },
            );
            targets.set(n, target());
        }

        const ops = buildSyntheticToolReclaimOps({
            db,
            sessionId,
            targets,
            watermark: 5,
        });

        expect(ops.map((op) => op.tagId)).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });
});
