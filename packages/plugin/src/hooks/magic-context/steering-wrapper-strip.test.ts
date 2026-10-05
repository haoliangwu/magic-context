import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getSourceContents,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { stripSystemInjection } from "./system-injection-stripper";
import { type MessageLike, tagMessages } from "./tag-messages";

// Byte-exact shape OpenCode 1.17.8 hands the transform for a user message sent
// while the agent is still running (captured from a real isolated 1.17.8 host).
// OpenCode 1.17.9 and later deliver the message unwrapped.
function steeringWrapped(userText: string): string {
    return [
        "<system-reminder>",
        "The user sent the following message:",
        userText,
        "",
        "Please address this message and continue with your tasks.",
        "</system-reminder>",
    ].join("\n");
}

const session = "steering-wrapper";
let db: NonNullable<ReturnType<typeof openDatabase>>;
let root: string;
let originalData: string | undefined;
let originalStorage: string | undefined;

beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    root = createTestTempDirFromPath(join(tmpdir(), "steering-wrapper-"));
    process.env.XDG_DATA_HOME = root;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    db = openDatabase()!;
});

afterEach(() => {
    closeDatabase();
    if (originalData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalData;
    if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
    rmSync(root, { recursive: true, force: true });
});

function toolTurn(id: string, callID: string): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "bash",
                callID,
                state: { status: "completed", input: { command: "true" }, output: `out ${callID}` },
            },
        ],
    };
}

function textOf(message: MessageLike): string {
    return (message.parts[0] as { text: string }).text;
}

describe("heuristic cleanup and OpenCode's mid-run steering wrapper", () => {
    it("keeps a wrapped user message that has aged out of the protected window", () => {
        const steer = "Stop and use the staging database instead.";
        const messages: MessageLike[] = [
            { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "run the job" }] },
            toolTurn("a1", "call-1"),
            {
                info: { id: "u2", role: "user" },
                parts: [{ type: "text", text: steeringWrapped(steer) }],
            },
            toolTurn("a2", "call-2"),
            toolTurn("a3", "call-3"),
            toolTurn("a4", "call-4"),
        ];
        const tagger = createTagger();
        tagger.initFromDb(session, db);
        const tagged = tagMessages(session, messages, tagger, db);
        const steerTag = tagged.messageTagNumbers.get(messages[2]);
        const firstLaterTool = tagged.messageTagNumbers.get(messages[3]);
        expect(steerTag).toBeDefined();
        expect(firstLaterTool).toBeGreaterThan(steerTag!);

        const result = applyHeuristicCleanup(
            session,
            db,
            tagged.targets,
            tagged.messageTagNumbers,
            // The wrapped message sits below the protected cutoff, the state a long
            // run reaches once newer tool calls push it out of the window.
            { protectedTagNumbers: new Set(), protectedCutoff: firstLaterTool! },
        );
        tagged.batch.finalize();

        expect(result.droppedInjections).toBe(0);
        const tag = getTagsBySession(db, session).find((row) => row.tagNumber === steerTag);
        expect(tag?.status).toBe("active");
        expect(textOf(messages[2])).toContain(steer);
        expect(textOf(messages[2])).not.toContain("[dropped");
        const source = getSourceContents(db, session, [steerTag!]).get(steerTag!);
        if (source !== undefined) expect(source).toContain(steer);
    });
});

describe("stripSystemInjection and the steering wrapper", () => {
    it("leaves a wrapped user message unchanged", () => {
        expect(stripSystemInjection(`§3§ ${steeringWrapped("use staging")}`)).toBeNull();
    });

    it("keeps a reminder the user's own words contain inside the wrapper", () => {
        const text = steeringWrapped("quote: <system-reminder>x</system-reminder> then go");
        expect(stripSystemInjection(text)).toBeNull();
    });

    it("still strips a harness reminder outside the wrapper", () => {
        const wrapped = steeringWrapped("use staging");
        const text = `${wrapped}\n\n<system-reminder>\nPlan mode is active.\n</system-reminder>`;
        expect(stripSystemInjection(text)).toBe(wrapped);
    });

    it("strips a lone harness reminder exactly as before", () => {
        expect(stripSystemInjection("<system-reminder>internal</system-reminder>")).toBe("");
        expect(stripSystemInjection("plain user text")).toBeNull();
    });
});
