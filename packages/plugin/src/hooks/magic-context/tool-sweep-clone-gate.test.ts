import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { copySessionStateForClone } from "../../features/magic-context/storage-clone";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { useScopedToolSweep } from "./tool-sweep-policy";

function cloneFixture(adopt: boolean) {
    const old = process.env.XDG_DATA_HOME;
    const home = createTestTempDirFromPath(join(tmpdir(), "scoped-clone-gate-"));
    process.env.XDG_DATA_HOME = home;
    try {
        const db = openDatabase();
        getOrCreateSessionMeta(db, "source");
        expect(useScopedToolSweep(db, "source", adopt)).toBe(adopt);
        const result = copySessionStateForClone(db, "source", "clone", {
            resolveBoundaryOrdinal: () => 1,
            includeTag: () => true,
            includeMessageId: () => true,
            selectPendingPiMarker: () => null,
        });
        expect(result.kind).toBe("migrated");
        const inherited = useScopedToolSweep(db, "clone", false);
        console.log(`SCOPED_GATE clone source_adopted=${adopt} inherited=${inherited}`);
        expect(inherited).toBe(adopt);
    } finally {
        closeDatabase();
        if (old === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = old;
        rmSync(home, { recursive: true, force: true });
    }
}

test("scoped gate pre-adoption clone remains legacy", () => cloneFixture(false));
test("scoped gate adopted clone retains priced sweep policy", () => cloneFixture(true));

test.skipIf(!process.env.MC_GATE_OLD_ROOT)(
    "scoped gate pre-fix reader tolerates reserved ledger entry",
    async () => {
        const root = process.env.MC_GATE_OLD_ROOT!;
        const { getMergedReasoningStrippedIds } = await import(
            `${root}/packages/plugin/src/features/magic-context/storage-meta-persisted.ts`
        );
        const { stripReasoningFromMergedAssistants } = await import(
            `${root}/packages/plugin/src/hooks/magic-context/strip-content.ts`
        );
        const home = createTestTempDirFromPath(join(tmpdir(), "scoped-old-reader-"));
        const old = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = home;
        try {
            const db = openDatabase();
            expect(useScopedToolSweep(db, "reader", true)).toBe(true);
            const frozenMessageIds = getMergedReasoningStrippedIds(db, "reader");
            const messages = [
                {
                    info: { id: "first", role: "assistant" },
                    parts: [{ type: "text", text: "text" }],
                },
                {
                    info: { id: "second", role: "assistant" },
                    parts: [{ type: "reasoning", text: "thinking" }],
                },
            ];
            const before = structuredClone(messages);
            expect(
                stripReasoningFromMergedAssistants(messages, "anthropic", { frozenMessageIds }),
            ).toBe(0);
            expect(messages).toEqual(before);
            console.log(
                `SCOPED_GATE pre-fix reader entries=${JSON.stringify([...frozenMessageIds])} stripped=0`,
            );
        } finally {
            closeDatabase();
            if (old === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = old;
            rmSync(home, { recursive: true, force: true });
        }
    },
);
