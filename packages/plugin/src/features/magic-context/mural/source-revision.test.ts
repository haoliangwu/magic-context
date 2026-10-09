import { afterEach, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureMuralRendered } from "./render-trigger";
import { muralSourceRevision } from "./source-revision";
import { computeCueContentHash, setMuralCue } from "./storage-mural-cues";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

test("mural source hashes cover cue, content, selection, expiry, deletion and empty-pool changes", () => {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const project = "fixture-project";
    const memories = Array.from({ length: 20 }, (_, index) => {
        const content = `Memory ${index}: stable constraint`;
        const memory = insertMemory(db, { projectPath: project, category: "CONSTRAINTS", content });
        setMuralCue(db, project, memory.id, `cue ${index}`, computeCueContentHash(content));
        return memory;
    });
    const original = muralSourceRevision(db, project);
    const rendered = ensureMuralRendered(db, project, 1);
    expect(rendered.hasMural).toBe(true);
    expect(muralSourceRevision(db, project)).toBe(original);
    // Unrelated session bookkeeping is not a mural source revision.
    db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("unrelated");
    expect(muralSourceRevision(db, project)).toBe(original);
    setMuralCue(db, project, memories[0].id, "new cue", computeCueContentHash(memories[0].content));
    const cueRevision = muralSourceRevision(db, project);
    expect(cueRevision).not.toBe(original);
    expect(ensureMuralRendered(db, project, 1).dataUrl).not.toBe(rendered.dataUrl);
    let previous = cueRevision;
    for (const [column, value] of [
        ["content", "changed without updating timestamps"],
        ["importance", 99],
        ["category", "NAMING"],
        ["status", "permanent"],
        ["last_seen_at", 42],
        ["verified_at", 43],
        ["expires_at", 1],
    ] as const) {
        db.prepare(`UPDATE memories SET ${column} = ? WHERE id = ?`).run(value, memories[1].id);
        const next = muralSourceRevision(db, project);
        expect(next).not.toBe(previous);
        previous = next;
    }
    db.prepare("DELETE FROM memories WHERE id = ?").run(memories[2].id);
    expect(muralSourceRevision(db, project)).not.toBe(previous);
    db.prepare("DELETE FROM memories WHERE project_path = ?").run(project);
    const empty = muralSourceRevision(db, project);
    expect(ensureMuralRendered(db, project, 1).hasMural).toBe(false);
    const added = insertMemory(db, {
        projectPath: project,
        category: "CONSTRAINTS",
        content: "new",
    });
    expect(muralSourceRevision(db, project)).not.toBe(empty);
    setMuralCue(db, project, added.id, "new cue", computeCueContentHash("new"));
    expect(ensureMuralRendered(db, project, 1).hasMural).toBe(true);
});
