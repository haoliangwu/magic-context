/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import { ENGINE_RECONNECTING_USER_MESSAGE } from "./emergency-fail-closed";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { createRustRefusalRecovery, RUST_REFUSAL_RECOVERY_PROMPT } from "./rust-refusal-recovery";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(5);
    }
    throw new Error("condition did not become true");
}

function recoveryFixture(
    latest: () => ReturnType<
        NonNullable<Parameters<typeof createRustRefusalRecovery>[0]["readLatestMessage"]>
    >,
) {
    let healthProbes = 0;
    const prompts: unknown[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method === "session.status") healthProbes += 1;
            return { ok: true };
        },
    };
    const client = {
        session: {
            messages: async () => ({ data: [] }),
            promptAsync: async (input: unknown) => {
                prompts.push(input);
            },
        },
    };
    const recovery = createRustRefusalRecovery({
        moduleClient,
        client,
        pollIntervalMs: 5,
        maxDurationMs: 100,
        probeTimeoutMs: 20,
        readLatestMessage: latest,
    });
    return { recovery, prompts, healthProbes: () => healthProbes };
}

const refusalRow = (sessionId: string, parentID = "user-1") => ({
    id: `assistant-${sessionId}`,
    role: "assistant",
    parentID,
    error: { name: "EmergencyFailClosedError", message: ENGINE_RECONNECTING_USER_MESSAGE },
});

describe("Rust post-refusal recovery", () => {
    it("delivers exactly one synthetic continue after a healthy probe for a refused subagent", async () => {
        const sessionId = "subagent-refusal";
        const fixture = recoveryFixture(() => refusalRow(sessionId));
        const arm = {
            sessionId,
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: false,
        };

        fixture.recovery.arm(arm);
        fixture.recovery.arm(arm);
        await waitUntil(() => fixture.prompts.length === 1);
        await sleep(20);

        expect(fixture.healthProbes()).toBe(1);
        expect(fixture.prompts).toHaveLength(1);
        expect(fixture.prompts[0]).toEqual({
            path: { id: sessionId },
            body: {
                noReply: false,
                parts: [
                    {
                        type: "text",
                        text: RUST_REFUSAL_RECOVERY_PROMPT,
                        synthetic: true,
                    },
                ],
            },
        });
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });

    it("delivers when the refused assistant child is still finalizing", async () => {
        const sessionId = "finalizing-refusal";
        const fixture = recoveryFixture(() => ({
            id: `assistant-${sessionId}`,
            role: "assistant",
            parentID: "user-1",
        }));

        fixture.recovery.arm({
            sessionId,
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: false,
        });

        await waitUntil(() => fixture.prompts.length === 1);
        expect(fixture.prompts).toHaveLength(1);
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });

    it("does not continue after the refused assistant child completed successfully", async () => {
        const fixture = recoveryFixture(() => ({
            id: "assistant-completed",
            role: "assistant",
            parentID: "user-1",
            completedAt: Date.now(),
        }));
        fixture.recovery.arm({
            sessionId: "completed",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: false,
        });

        await waitUntil(() => fixture.healthProbes() === 1);
        await sleep(20);
        expect(fixture.prompts).toHaveLength(0);
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });

    it("does not continue when a newer user message replaced the refused assistant tail", async () => {
        const fixture = recoveryFixture(() => ({ id: "user-2", role: "user" }));
        fixture.recovery.arm({
            sessionId: "user-advanced",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: false,
        });

        await waitUntil(() => fixture.healthProbes() === 1);
        await sleep(20);
        expect(fixture.prompts).toHaveLength(0);
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });

    it("does not arm for a provider-proven emergency or compaction-off session", async () => {
        const fixture = recoveryFixture(() => refusalRow("unsafe"));
        fixture.recovery.arm({
            sessionId: "unsafe",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: true,
            compactionOff: false,
        });
        fixture.recovery.arm({
            sessionId: "compaction-off",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: true,
        });

        await sleep(20);
        expect(fixture.healthProbes()).toBe(0);
        expect(fixture.prompts).toHaveLength(0);
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });

    it("cancels the watcher when the session is deleted", async () => {
        const fixture = recoveryFixture(() => refusalRow("deleted"));
        fixture.recovery.arm({
            sessionId: "deleted",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "user-1",
            providerProvenEmergency: false,
            compactionOff: false,
        });
        fixture.recovery.cancel("deleted");

        await sleep(20);
        expect(fixture.healthProbes()).toBe(0);
        expect(fixture.prompts).toHaveLength(0);
        expect(fixture.recovery.activeCountForTests()).toBe(0);
    });
});
