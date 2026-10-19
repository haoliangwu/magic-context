import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePluginConfig } from ".";
import {
    configDependencyNotes,
    logConfigDependencyNotesOnce,
    resetConfigDependencyNotesForTest,
} from "./dependency-notes";

afterEach(() => resetConfigDependencyNotesForTest());

const notesFor = (raw: Record<string, unknown>) => configDependencyNotes(parsePluginConfig(raw));

test("a default or fully enabled config produces no dependency notes", () => {
    expect(notesFor({})).toEqual([]);
    expect(notesFor({ dreamer: {} })).toEqual([]);
    expect(notesFor({ dreamer: {}, memory: { enabled: true } })).toEqual([]);
    // Memory off without a runnable dreamer has no dreamer schedule to lose.
    expect(notesFor({ memory: { enabled: false } })).toEqual([]);
    expect(
        notesFor({
            dreamer: { disable: true },
            smart_notes: { enabled: false },
            memory: { enabled: false },
        }),
    ).toHaveLength(1);
});

test("memory off with a runnable dreamer names the dreamer schedule it stops", () => {
    const notes = notesFor({ dreamer: {}, memory: { enabled: false } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe(
        "memory.enabled is false, so these scheduled dreamer tasks do not run for this project, on schedule or through /ctx-dream: map-memories, verify, verify-broad, curate, compress-cues, classify-memories, retrospective, promote-primers, refresh-primers. maintain-docs, evaluate-smart-notes and review-user-memories still run.",
    );
    // Every task unscheduled: nothing is lost, so nothing is reported.
    const tasks = Object.fromEntries(
        [
            "map-memories",
            "verify",
            "verify-broad",
            "curate",
            "compress-cues",
            "classify-memories",
            "retrospective",
            "maintain-docs",
            "evaluate-smart-notes",
            "review-user-memories",
            "promote-primers",
            "refresh-primers",
        ].map((task) => [task, { schedule: "" }]),
    );
    expect(notesFor({ dreamer: { tasks }, memory: { enabled: false } })).toEqual([]);
    // Only tasks that do not need project memory scheduled: nothing is lost either.
    const nonMemory = {
        ...tasks,
        "maintain-docs": { schedule: "0 1 * * *" },
        "evaluate-smart-notes": { schedule: "0 3 * * *" },
        "review-user-memories": { schedule: "0 3 * * *" },
    };
    expect(notesFor({ dreamer: { tasks: nonMemory }, memory: { enabled: false } })).toEqual([]);
    // One memory task scheduled: the note names just that one.
    expect(
        notesFor({
            dreamer: { tasks: { ...tasks, curate: { schedule: "0 4 * * 0" } } },
            memory: { enabled: false },
        }),
    ).toEqual([
        "memory.enabled is false, so these scheduled dreamer tasks do not run for this project, on schedule or through /ctx-dream: curate. maintain-docs, evaluate-smart-notes and review-user-memories still run.",
    ]);
});

test("a disabled dreamer reports smart notes and the user-memory review schedule", () => {
    const notes = notesFor({ dreamer: { disable: true } });
    expect(notes).toEqual([
        expect.stringContaining("smart_notes.enabled has no effect") as unknown as string,
        expect.stringContaining(
            "dreamer.tasks.review-user-memories.schedule has no effect",
        ) as unknown as string,
    ]);
    expect(notesFor({ dreamer: { disable: true }, smart_notes: { enabled: false } })).toHaveLength(
        1,
    );
    expect(
        notesFor({
            dreamer: { disable: true, tasks: { "review-user-memories": { schedule: "" } } },
            smart_notes: { enabled: false },
        }),
    ).toEqual([]);
});

test("each note is logged once per process", () => {
    const lines: string[] = [];
    const config = parsePluginConfig({ dreamer: { disable: true } });
    expect(logConfigDependencyNotesOnce(config, (line) => lines.push(line))).toHaveLength(2);
    expect(logConfigDependencyNotesOnce(config, (line) => lines.push(line))).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("[magic-context] config note: "))).toBe(true);
    // A second plugin instance with a different config still reports its own notes.
    const memoryOff = parsePluginConfig({ dreamer: {}, memory: { enabled: false } });
    expect(logConfigDependencyNotesOnce(memoryOff, (line) => lines.push(line))).toHaveLength(1);
    expect(lines).toHaveLength(3);
});

test("every host logs the dependency notes at startup", () => {
    const src = join(import.meta.dir, "..");
    for (const [file, call] of [
        ["index.ts", "logConfigDependencyNotesOnce(pluginConfig, log);"],
        ["v2/hooks/context.ts", "logConfigDependencyNotesOnce(config, log);"],
        ["../../pi-plugin/src/index.ts", "logConfigDependencyNotesOnce(config, log);"],
    ] as const) {
        expect(readFileSync(join(src, file), "utf8")).toContain(call);
    }
});
