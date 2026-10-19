import { describe, expect, it } from "bun:test";
import type { MessageLike } from "./tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";

const modes = [
    "editMarker",
    "editMarkerStripped",
    "skeletonReal",
    "skeletonStripped",
    "truncate",
] as const;

function fixture(metadata: unknown = { nested: { values: ["untouched"] } }) {
    const input = () => ({
        filePath: "src/example.ts",
        oldString: "before".repeat(100),
        newString: "after".repeat(100),
        nested: { content: "nested arguments must stay unchanged" },
    });
    return [
        {
            type: "tool",
            callID: "call",
            state: {
                status: "completed",
                output: "original result",
                input: input(),
                metadata,
                attachments: [{ type: "file", url: "data:synthetic" }],
            },
        },
        { type: "tool-invocation", callID: "call", args: input() },
        { type: "tool_use", id: "call", input: input() },
        { type: "tool_result", tool_use_id: "call", content: "original result" },
    ];
}

function targetFor(parts: unknown[], tag = 7) {
    const message: MessageLike = { info: { id: "message", role: "assistant" }, parts };
    const index: ToolCallIndex = new Map();
    const occurrences = parts.map((part) => {
        const observation = extractToolCallObservation(part);
        if (!observation) throw new Error("fixture must contain tool occurrences");
        return { part, message, kind: observation.kind };
    });
    index.set("call", {
        occurrences,
        hasResult: parts.some(partHasCompletedResult),
    });
    return {
        message,
        target: createToolDropTarget("call", [], index, new ToolMutationBatch([message]), tag),
    };
}

describe("tool clamp copy-on-write", () => {
    it("isolates every rewritten container from the live part and nested metadata", () => {
        for (const mode of modes) {
            const originals = fixture();
            const snapshot = JSON.stringify(originals);
            const { message, target } = targetFor([...originals]);
            expect(target[mode]()).toBe("truncated");
            expect(JSON.stringify(originals)).toBe(snapshot);
            const served = message.parts as any[];
            for (let i = 0; i < served.length; i++) {
                const original = originals[i] as any;
                const copy = served[i];
                if (JSON.stringify(copy) === JSON.stringify(original)) continue;
                expect(copy).not.toBe(original);
                if (copy.type === "tool") {
                    expect(copy.state).not.toBe(original.state);
                    expect(copy.state.metadata).toEqual(original.state.metadata);
                    if (mode.startsWith("editMarker") || mode === "truncate") {
                        expect(copy.state.input).not.toBe(original.state.input);
                        copy.state.input.probe = "served only";
                    }
                    if (mode.endsWith("Stripped")) {
                        expect(copy.state.attachments).not.toBe(original.state.attachments);
                        copy.state.attachments.push({ type: "file", url: "served only" });
                    }
                    copy.state.output = "served only";
                } else if (copy.type === "tool-invocation") {
                    expect(copy.args).not.toBe(original.args);
                    copy.args.probe = "served only";
                } else if (copy.type === "tool_use") {
                    expect(copy.input).not.toBe(original.input);
                    copy.input.probe = "served only";
                } else {
                    copy.content = "served only";
                }
            }
            expect(JSON.stringify(originals)).toBe(snapshot);
        }
    });

    it("copies zero metadata bytes while clamping large tool parts", () => {
        let copiedBytes = 0;
        const payload = "m".repeat(2 * 1024 * 1024);
        const metadata = {
            get payload() {
                copiedBytes += payload.length;
                return payload;
            },
        };
        let clamped = 0;
        for (const mode of modes) {
            for (let i = 0; i < 200; i++) {
                const { message, target } = targetFor(fixture(metadata));
                expect(target[mode]()).toBe("truncated");
                expect((message.parts[0] as any).state.output).toBe("[dropped §7§]");
                clamped++;
            }
        }
        expect(clamped).toBe(1000);
        expect(copiedBytes).toBe(0);
    });

    it("reuses already marked occurrences without copying and restores pristine invocations", () => {
        for (const mode of modes) {
            const first = targetFor(fixture());
            first.target[mode]();
            const marked = [...first.message.parts];
            const replay = targetFor([...marked]);
            replay.target[mode]();
            for (let i = 0; i < marked.length; i++) expect(replay.message.parts[i]).toBe(marked[i]);
            const before = JSON.stringify(replay.message.parts);
            replay.target[mode]();
            expect(JSON.stringify(replay.message.parts)).toBe(before);
        }
        const originals = fixture();
        const { message, target } = targetFor([...originals]);
        target.truncate();
        target.editMarker();
        expect((message.parts[0] as any).state.input.filePath).toBe("src/example.ts");
        target.skeletonReal();
        expect((message.parts[0] as any).state.input).toEqual(originals[0].state?.input);
        expect(message.parts[1]).toBe(originals[1]);
        expect(message.parts[2]).toBe(originals[2]);
    });
});
