import { describe, expect, it } from "bun:test";
import {
    classifyLeadingTag,
    isMarkerOnly,
    isMarkerOnlyOutput,
    measureExposure,
    neutralizeRequest,
    placeholderHits,
} from "./placeholder";

const request = () => ({
    model: "m",
    messages: [
        { role: "system", content: "A cleared item leaves a `[dropped §N§]` placeholder. ctx_expand takes `[dropped §12§]`." },
        { role: "user", content: "§1§ Read the parser." },
        {
            role: "assistant",
            content: "§2§ Reading.",
            tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{"dropped":"[dropped §3§]"}' } }],
        },
        { role: "tool", tool_call_id: "a", content: "[dropped §3§]" },
        { role: "assistant", content: [{ type: "text", text: "[dropped]" }] },
        { role: "assistant", content: "§5§ [dropped §5§]\n[dropped §6§]" },
        // A file that merely mentions the placeholder must reach the model unchanged.
        { role: "tool", tool_call_id: "b", content: "§7§ const s = `[dropped §${n}§]`; // [dropped §9§] in source" },
        {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: '{"command":"echo [dropped §3§]"}' } }],
        },
    ],
    tools: [{ type: "function", function: { name: "ctx_expand", description: "tag from a [dropped §12§] placeholder", parameters: { properties: { tag: { description: "or [dropped §N§]" } } } } }],
});

describe("neutralizeRequest", () => {
    it("rewrites every Magic Context render and the prose that documents it", () => {
        const out = neutralizeRequest(request());
        const m = out.messages;
        expect(m[0]!.content).toBe("A cleared item leaves a `(removed: tag N)` placeholder. ctx_expand takes `(removed: tag 12)`.");
        expect(m[2]!.tool_calls![0]!.function.arguments).toBe('{"removed":"(removed: tag 3)"}');
        expect(m[3]!.content).toBe("(removed: tag 3)");
        expect(m[4]!.content).toEqual([{ type: "text", text: "(removed)" }]);
        expect(m[5]!.content).toBe("§5§ (removed: tag 5)\n(removed: tag 6)");
        expect(out.tools[0]!.function.description).toBe("tag from a (removed: tag 12) placeholder");
        expect(out.tools[0]!.function.parameters).toEqual({ properties: { tag: { description: "or (removed: tag N)" } } });
    });

    it("leaves content that only mentions a placeholder untouched", () => {
        const out = neutralizeRequest(request());
        expect(out.messages[6]!.content).toBe(request().messages[6]!.content);
        expect(out.messages[7]!.tool_calls![0]!.function.arguments).toBe('{"command":"echo [dropped §3§]"}');
        expect(out.messages[1]!.content).toBe("§1§ Read the parser.");
    });

    it("is a pure function, so repeated passes produce identical bytes", () => {
        expect(JSON.stringify(neutralizeRequest(request()))).toBe(JSON.stringify(neutralizeRequest(request())));
    });
});

describe("measureExposure", () => {
    it("counts the same drops in either wording", () => {
        const bracket = measureExposure(request());
        expect(bracket).toEqual({ droppedToolResults: 1, droppedToolInputs: 1, droppedTextParts: 2, droppedTags: 4, maxTag: 7 });
        expect(measureExposure(neutralizeRequest(request()))).toEqual(bracket);
    });
});

describe("output classification", () => {
    it("recognizes marker-only renders and outputs", () => {
        expect(isMarkerOnly("§4§ [dropped §4§]")).toBe(true);
        expect(isMarkerOnly("see [dropped §4§]")).toBe(false);
        expect(isMarkerOnlyOutput("§12§ [dropped]")).toBe(true);
        expect(isMarkerOnlyOutput("§12§\n\n")).toBe(true);
        expect(isMarkerOnlyOutput("(removed: tag 9)")).toBe(true);
        expect(isMarkerOnlyOutput("§12§ Reading the file.")).toBe(false);
        expect(isMarkerOnlyOutput("   ")).toBe(false);
    });

    it("finds placeholder shapes and near variants in both wordings", () => {
        expect(placeholderHits("§3§ [dropped] then [dropped §4§] and [Dropped 5]")).toEqual({ "bracket-dropped": 3 });
        expect(placeholderHits("(removed: tag 4) and (removed)")).toEqual({ "neutral-removed": 2, "removed-tag-prose": 1 });
        expect(placeholderHits("I removed the comment (as asked).")).toEqual({});
    });

    it("classifies the leading tag against one more than the highest visible tag", () => {
        expect(classifyLeadingTag("§8§ ok", 7)).toEqual({ kind: "correct", tag: 8, delta: 0 });
        expect(classifyLeadingTag("§7§ ok", 7)).toEqual({ kind: "wrong", tag: 7, delta: -1 });
        expect(classifyLeadingTag("ok §8§", 7)).toEqual({ kind: "missing", tag: null, delta: null });
    });
});
