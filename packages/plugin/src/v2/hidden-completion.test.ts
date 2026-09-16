import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidatedHistorianPass } from "../hooks/magic-context/compartment-runner-historian";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import { createV2HiddenCompletionExecutor } from "./hidden-completion";
import type { SessionContext } from "./hooks/types";

const run: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian-editor",
    kind: "historian-editor",
    system: "calibrated editor system",
    timeoutMs: 1000,
    title: "hidden",
    directory: "/project",
};
function draft(prompt: string): SessionContext {
    return {
        sessionID: "user-session",
        model: { providerID: "mock", id: "current" },
        agent: "build",
        system: [{ type: "text", text: "host system" }],
        tools: { read: { description: "read", input: {} } },
        options: {},
        messages: [
            {
                id: "history",
                role: "assistant",
                content: [{ type: "text", text: "private session history" }],
            },
            { role: "user", content: [{ type: "text", text: prompt }] },
        ],
    };
}
async function setup(completion = "editor completion") {
    let hook: (value: SessionContext) => Promise<void> = async () => {};
    const requests: SessionContext[] = [];
    const executor = await createV2HiddenCompletionExecutor(
        {
            async hook(_name, callback) {
                hook = callback;
            },
            async generate(input) {
                const value = draft(input.prompt);
                await hook(value);
                requests.push(structuredClone(value));
                return { text: completion };
            },
        },
        () => ({ providerID: "mock", modelID: "current" }),
    );
    return { executor, requests, hook: (value: SessionContext) => hook(value) };
}
const request = (modelID?: string) => ({
    path: { id: "not-a-child" },
    body: {
        ...(modelID ? { model: { providerID: "mock", modelID } } : {}),
        parts: [{ type: "text", text: "calibrated chunk", synthetic: true }],
    },
});

describe("hidden generate lifecycle", () => {
    test("warming-shaped generate is byte-untouched", async () => {
        const { hook } = await setup();
        const value = draft("Keep the transcript prefix warm");
        const bytes = JSON.stringify(value);
        const messages = value.messages;
        const system = value.system;
        await hook(value);
        expect(JSON.stringify(value)).toBe(bytes);
        expect(value.messages).toBe(messages);
        expect(value.system).toBe(system);
    });
    test("unset model uses session model and collects separately without a child", async () => {
        const { executor, requests } = await setup();
        const handle = await executor.open(run);
        expect(handle.childSessionId).toBeUndefined();
        expect(requests).toHaveLength(0);
        await executor.attempt(handle, request());
        expect(requests).toHaveLength(1);
        expect(requests[0]!.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "calibrated chunk" }] },
        ]);
        expect(requests[0]!.system).toEqual([{ type: "text", text: run.system }]);
        expect(requests[0]!.tools).toEqual({});
        const completion = await executor.collect(handle, 50);
        expect(completion.text).toBe("editor completion");
        expect(completion.usage.input).toBeGreaterThan(0);
        expect(completion.usage.output).toBeGreaterThan(0);
        expect(completion.messages).toBeUndefined();
        await executor.close(handle, {
            promptSettled: true,
            privacySensitive: false,
            context: "historian",
            log() {},
        });
        expect(requests).toHaveLength(1);
    });
    test("configured-differing-only refuses at open with zero provider requests", async () => {
        const { executor, requests } = await setup();
        await expect(
            executor.open({ ...run, model: "mock/cheap", configuredModels: ["mock/cheap"] }),
        ).rejects.toBeInstanceOf(HiddenCompletionRefusal);
        expect(requests).toHaveLength(0);
    });
    test("configured matching fallback remains usable and differing attempt sends nothing", async () => {
        const { executor, requests } = await setup();
        const handle = await executor.open({
            ...run,
            model: "mock/cheap",
            configuredModels: ["mock/cheap", "mock/current"],
        });
        await expect(executor.attempt(handle, request("cheap"))).rejects.toBeInstanceOf(
            HiddenCompletionRefusal,
        );
        expect(requests).toHaveLength(0);
        await executor.attempt(handle, request("current"));
        expect(requests).toHaveLength(1);
        expect((await executor.collect(handle, 50)).modelId).toBe("current");
    });
    test("unregistered sentinel lookalike is untouched", async () => {
        const { hook } = await setup();
        const value = draft("mc:hidden:unknown:unknown");
        const bytes = JSON.stringify(value);
        await hook(value);
        expect(JSON.stringify(value)).toBe(bytes);
    });
});

for (const matchingFallback of [false, true]) {
    test(`shared historian preserves configured-chain refusal and fallback semantics (matching=${matchingFallback})`, async () => {
        const { executor, requests } = await setup(
            '<compartment start="1" end="2" title="Fallback"><p1>Both messages.</p1></compartment>',
        );
        const db = new Database(":memory:");
        const directory = mkdtempSync(join(tmpdir(), "mc-hidden-chain-"));
        try {
            const result = await runValidatedHistorianPass({
                client: undefined,
                hiddenCompletionExecutor: executor,
                db,
                parentSessionId: "user-session",
                sessionDirectory: directory,
                prompt: "Messages 1-2",
                chunk: {
                    startIndex: 1,
                    endIndex: 2,
                    lines: [
                        { ordinal: 1, messageId: "one" },
                        { ordinal: 2, messageId: "two" },
                    ],
                },
                priorCompartments: [],
                sequenceOffset: 0,
                dumpLabelBase: "hidden-fallback",
                model: "mock/cheap",
                fallbackModels: matchingFallback ? ["mock/current"] : [],
                fallbackModelId: "mock/current",
            });
            expect(result.ok).toBe(matchingFallback);
            expect(requests).toHaveLength(matchingFallback ? 1 : 0);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
