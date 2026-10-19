/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import { closeDatabase, insertTag, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import type { MessageLike, TagTarget } from "./tag-messages";
import { buildSyntheticToolReclaimOps, toolReclaimDistanceEntries } from "./tool-reclaim";

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

describe("toolReclaimDistanceEntries", () => {
    it("retains synthetic and ignored provenance without hiding an authored image", () => {
        for (const provenance of [{ synthetic: true }, { ignored: true }]) {
            const message = {
                info: { id: "user", role: "user" },
                parts: [
                    { type: "text", text: "Host notice", ...provenance },
                    { type: "file", mime: "image/png", url: "https://example.invalid/user.png" },
                ],
            } as unknown as MessageLike;
            expect(
                toolReclaimDistanceEntries([message], new Map()).map((e) => !!e.userTurn),
            ).toEqual([false, true]);
            message.parts.pop();
            expect(toolReclaimDistanceEntries([message], new Map()).some((e) => e.userTurn)).toBe(
                false,
            );
        }
    });

    it("prices inline images and tool attachments by the same pixels as the wire", () => {
        const header = Buffer.alloc(24);
        header.write("\u0089PNG\r\n\u001a\n", 0, "binary");
        header.writeUInt32BE(400, 16);
        header.writeUInt32BE(300, 20);
        const image = {
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${header.toString("base64")}`,
        };
        const message = {
            info: { id: "images", role: "assistant" },
            parts: [image, { type: "tool", state: { attachments: [image] } }],
        } as unknown as MessageLike;
        const entries = toolReclaimDistanceEntries([message], new Map());
        const wire = estimateMessageTokens(message);
        expect(entries[0]?.tokens).toBe(160);
        expect(wire.conversation).toBe(160);
        // The native tool entry also includes its serialized input/output framing.
        const framing = toolReclaimDistanceEntries(
            [{ ...message, parts: [{ type: "tool", state: {} }] } as unknown as MessageLike],
            new Map(),
        );
        expect((entries[1]?.tokens ?? 0) - (framing[0]?.tokens ?? 0)).toBe(160);
        expect(wire.toolCall).toBe(160);
    });
});

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
