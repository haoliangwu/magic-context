/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
    containsDroppedInputPlaceholder,
    createDroppedInputGuard,
    createDroppedInputToolExecuteBeforeHook,
    droppedInputRefusalMessage,
    recordToolParameters,
    toolParameterNames,
} from "./dropped-input-guard";

const blockedInputs: Array<[string, unknown]> = [
    ["tagged drop sentinel", { command: "[dropped §431§]" }],
    ["legacy five-character truncation", { command: "which...[truncated]" }],
    ["legacy array summary", { files: "[3 items]" }],
    ["legacy object summary", { metadata: "[object]" }],
    ["new dropped marker object", { dropped: "[dropped §431§]" }],
];

const bashSchema = {
    type: "object",
    properties: {
        timeout: { type: "number" },
        command: { type: "string" },
        workdir: { type: "string" },
    },
    required: ["command"],
};

describe("dropped input execution guard", () => {
    for (const [label, input] of blockedInputs) {
        it(`detects the ${label}`, () => {
            expect(containsDroppedInputPlaceholder(input)).toBe(true);
        });
    }

    it("walks nested input without mistaking explanatory prose for a placeholder", () => {
        expect(
            containsDroppedInputPlaceholder({ nested: [{ value: "abcde...[truncated]" }] }),
        ).toBe(true);
        expect(
            containsDroppedInputPlaceholder({
                content: "The log used ...[truncated] before the final retry.",
            }),
        ).toBe(false);
        // A real value that ends with the sentinel text is longer than any copied
        // placeholder (five characters plus the sentinel) and must stay executable.
        expect(
            containsDroppedInputPlaceholder({
                content: "expected output line 1\nexpected output line 2\n...[truncated]",
            }),
        ).toBe(false);
    });

    it("rejects through the OpenCode tool.execute.before hook", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();

        await expect(
            hook(
                { tool: "write", sessionID: "ses-431", callID: "call-431" },
                { args: { filePath: "/tmp/...[truncated]", content: "payload" } },
            ),
        ).rejects.toThrow("placeholder Magic Context shows");
    });

    it("allows ordinary executable arguments", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        await expect(
            hook(
                { tool: "bash", sessionID: "ses-clean", callID: "call-clean" },
                { args: { command: "which docker" } },
            ),
        ).resolves.toBeUndefined();
    });
});

describe("dropped input refusal text", () => {
    it("names the copied dropped marker, says it is a placeholder, and lists schema parameters", () => {
        const message = droppedInputRefusalMessage({
            toolName: "bash",
            input: { dropped: "[dropped §768§]" },
            parameters: bashSchema,
            consecutive: 1,
        });

        expect(message).toContain('your arguments to `bash` were {"dropped":"[dropped §768§]"}');
        expect(message).toContain(
            "the placeholder Magic Context shows in place of an earlier call's arguments",
        );
        expect(message).toContain("not a value to send");
        expect(message).toContain("Nothing is wrong with the session or the tool");
        // Required parameters come first, then the rest in schema order.
        expect(message).toContain(
            "Call `bash` again with real values for its parameters: command (required), timeout, workdir.",
        );
        expect(message).toContain(
            "Only if you need the original arguments of an earlier dropped call",
        );
        expect(message).toContain("ctx_expand");
        expect(message).not.toContain("in a row");
        expect(message.split("\n").length).toBeLessThanOrEqual(4);
    });

    it("quotes the legacy truncated shape as received", () => {
        const message = droppedInputRefusalMessage({
            toolName: "bash",
            input: { command: "which...[truncated]" },
            parameters: bashSchema,
            consecutive: 1,
        });

        expect(message).toContain('were {"command":"which...[truncated]"}');
        expect(message).toContain("command (required), timeout, workdir");
    });

    it("quotes a nested placeholder and shortens long arguments", () => {
        const message = droppedInputRefusalMessage({
            toolName: "edit",
            input: {
                filePath: "/repo/src/app.ts",
                edits: [{ oldString: "[dropped §12§]", newString: "x".repeat(400) }],
            },
            parameters: undefined,
            consecutive: 1,
        });

        expect(message).toContain('were {"filePath":"/repo/src/app.ts","edits":[{"oldString"');
        expect(message).not.toContain("x".repeat(300));
        expect(message).toContain("…");
        // Without a visible schema, the text must not invent parameter names.
        expect(message).toContain(
            "Call `edit` again with real values for the tool's own parameters.",
        );
    });

    it("reads parameter names from a zod object schema the way OpenCode hands them over", () => {
        const names = toolParameterNames(
            z.object({
                pattern: z.string(),
                path: z.string().optional(),
                include: z.string().optional(),
            }),
        );

        expect(names).toEqual({ required: ["pattern"], optional: ["path", "include"] });
    });

    it("uses the recorded tool schema when the guard is not handed one", () => {
        recordToolParameters("dropped-guard-test-search", {
            type: "object",
            properties: { query: { type: "string" }, topK: { type: "number" } },
            required: ["query"],
        });
        const guard = createDroppedInputGuard();

        const message = guard.check({
            sessionID: "ses-schema",
            toolName: "dropped-guard-test-search",
            input: { dropped: "[dropped §770§]" },
        });

        expect(message).toContain("its parameters: query (required), topK.");
    });
});

describe("consecutive dropped input refusals", () => {
    it("counts refusals per session and resets on the next accepted call", () => {
        const guard = createDroppedInputGuard({ parametersFor: () => bashSchema });
        const refused = { toolName: "bash", input: { dropped: "[dropped §768§]" } };

        const first = guard.check({ sessionID: "ses-a", ...refused });
        const second = guard.check({ sessionID: "ses-a", ...refused });
        const third = guard.check({ sessionID: "ses-a", ...refused });
        const otherSession = guard.check({ sessionID: "ses-b", ...refused });

        expect(first).not.toContain("in a row");
        expect(second).toContain("This is the 2nd call in a row with placeholder arguments.");
        expect(third).toContain("This is the 3rd call in a row with placeholder arguments.");
        expect(otherSession).not.toContain("in a row");

        expect(
            guard.check({ sessionID: "ses-a", toolName: "bash", input: { command: "ls" } }),
        ).toBeUndefined();
        expect(guard.check({ sessionID: "ses-a", ...refused })).not.toContain("in a row");
    });

    it("counts across calls through the OpenCode hook", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        const refusal = async () => {
            try {
                await hook(
                    { tool: "bash", sessionID: "ses-hook", callID: "call" },
                    { args: { dropped: "[dropped §769§]" } },
                );
            } catch (error) {
                return (error as Error).message;
            }
            throw new Error("placeholder call was not refused");
        };

        expect(await refusal()).not.toContain("in a row");
        expect(await refusal()).toContain("This is the 2nd call in a row");
        await hook(
            { tool: "bash", sessionID: "ses-hook", callID: "call-ok" },
            { args: { command: "ls" } },
        );
        expect(await refusal()).not.toContain("in a row");
    });
});
