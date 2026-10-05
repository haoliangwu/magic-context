/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { RustModeModuleClient } from "../../hooks/magic-context/rust-mode-transform";
import { RUST_REFUSAL_RECOVERY_PROMPT } from "../../hooks/magic-context/rust-refusal-recovery";
import type { StoreRow } from "../store-reader";
import { createV2RustRefusalRecovery, refusedStepStillCurrent } from "./rust-mode";
import type { V2Context } from "./types";

const rows: StoreRow[] = [
    { id: "u1", session_id: "ses", seq: 0, type: "user", data: { text: "first" } },
    { id: "a1", session_id: "ses", seq: 1, type: "assistant", data: { content: [] } },
    { id: "u2", session_id: "ses", seq: 2, type: "user", data: { text: "refused turn" } },
    { id: "a2", session_id: "ses", seq: 3, type: "assistant", data: { content: [] } },
];

describe("refusedStepStillCurrent", () => {
    it("is current while nothing but assistant work follows the refused turn", () => {
        expect(refusedStepStillCurrent(rows, "u2")).toBe(true);
    });

    it("is not current once a newer user turn exists", () => {
        expect(refusedStepStillCurrent(rows, "u1")).toBe(false);
    });

    it("treats a synthetic turn as a newer user turn", () => {
        const withSynthetic: StoreRow[] = [
            ...rows,
            { id: "s1", session_id: "ses", seq: 4, type: "synthetic", data: { text: "continue" } },
        ];
        expect(refusedStepStillCurrent(withSynthetic, "u2")).toBe(false);
    });

    it("is not current when the refused turn is no longer in the store", () => {
        expect(refusedStepStillCurrent(rows, "reverted")).toBe(false);
    });
});

describe("createV2RustRefusalRecovery", () => {
    function harness(history: StoreRow[]) {
        const synthetics: Array<{ sessionID: string; text: string; delivery?: string }> = [];
        const stored = new Map<string, unknown>();
        const context = {
            session: {
                synthetic: async (input: {
                    sessionID: string;
                    id: string;
                    text: string;
                    delivery?: string;
                }) => {
                    synthetics.push({
                        sessionID: input.sessionID,
                        text: input.text,
                        ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
                    });
                },
            },
            storage: {
                set: async (key: string, value: unknown) => {
                    stored.set(key, value);
                },
                get: async (key: string) => stored.get(key) ?? null,
            },
        } as unknown as Pick<V2Context, "session" | "storage">;
        const moduleClient = {
            call: async () => ({ result: {} }),
        } as unknown as RustModeModuleClient;
        const recovery = createV2RustRefusalRecovery({
            context,
            moduleClient,
            readRowsFrom: (_sessionID, messageID) => {
                const at = history.findIndex((row) => row.id === messageID);
                return at < 0 ? [] : history.slice(at);
            },
            pollIntervalMs: 5,
            probeTimeoutMs: 200,
        });
        return { recovery, synthetics, stored };
    }

    async function settle(): Promise<void> {
        // One poll interval plus slack; the watcher is armed with a 5 ms poll below.
        await Bun.sleep(60);
    }

    it("delivers the continue through this host's synthetic carrier", async () => {
        const { recovery, synthetics, stored } = harness(rows);
        recovery.arm({
            sessionId: "ses",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "u2",
            providerProvenEmergency: false,
            compactionOff: false,
        });
        await settle();
        expect(synthetics).toHaveLength(1);
        expect(synthetics[0]).toMatchObject({
            sessionID: "ses",
            text: RUST_REFUSAL_RECOVERY_PROMPT,
            delivery: "steer",
        });
        // The synthetic is admitted before it is sent, so the next context pass
        // recognises it as Magic Context's own rather than as user input.
        expect([...stored.keys()].every((key) => key.startsWith("synthetic/ses/"))).toBe(true);
        expect(recovery.activeCountForTests()).toBe(0);
    });

    it("stays silent when the conversation has already moved past the refused turn", async () => {
        const { recovery, synthetics } = harness(rows);
        recovery.arm({
            sessionId: "ses",
            projectRoot: "/tmp/project",
            refusedUserMessageId: "u1",
            providerProvenEmergency: false,
            compactionOff: false,
        });
        await settle();
        expect(synthetics).toEqual([]);
        expect(recovery.activeCountForTests()).toBe(0);
    });
});
