import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getSourceContents } from "../../features/magic-context/storage-source";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { tagMessages } from "./tag-messages";

test("proven host edits replace pristine tag text while ordinary passes retain their frozen source", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const tagger = createTagger();
    const pass = (text: string, refreshSourceContents = false) => {
        const draft: SessionContext = {
            sessionID: "s",
            model: { providerID: "p", id: "m" },
            agent: "build",
            messages: [{ id: "u", role: "user", content: [{ type: "text", text }] }],
            system: [],
            tools: {},
            options: {},
        };
        const mapped = adaptPayload(draft);
        tagger.initFromDb("s", db);
        tagMessages("s", mapped.messages, tagger, db, { refreshSourceContents });
        mapped.commit();
        return draft.messages[0]?.content[0]?.text;
    };
    try {
        expect(pass("original host text")).toBe("§1§ original host text");
        expect(pass("unproven wire change")).toBe("§1§ original host text");
        expect(pass("proven edited host text", true)).toBe("§1§ proven edited host text");
        expect(getSourceContents(db, "s", [1]).get(1)).toBe("proven edited host text");
        expect(pass("another unproven change")).toBe("§1§ proven edited host text");
        expect(
            (
                db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id='s'").get() as {
                    n: number;
                }
            ).n,
        ).toBe(1);
    } finally {
        db.close();
    }
});
