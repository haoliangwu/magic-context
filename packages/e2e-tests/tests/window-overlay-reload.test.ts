/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    createScenarioHarness,
    createSessionAndPrompt,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

const INITIAL_PRESSURE = 21.784593935169045;
const RELOADED_PRESSURE = 13.174536256323776;

function writeOverlay(path: string, enforcedWindow: number): void {
    const fact = {
        value: { kind: "stated", value: enforcedWindow },
        grade: "measured",
        units: "provider",
        boundary: "Observed",
        source_ref: "overlay-reload-e2e",
        observed_at: "2026-09-01T00:00:00Z",
    };
    writeFileSync(
        path,
        JSON.stringify({
            schema: "fusiform-window-overlay/v1",
            generated_at: "2026-09-01T00:00:00Z",
            minted_provider_ids: [],
            cells: [
                {
                    provider_id: "mock",
                    model_id: "mock-model",
                    facts: { "window.enforced": fact },
                },
                {
                    provider_id: "mock-anthropic",
                    model_id: "mock-sonnet",
                    facts: { "window.enforced": fact },
                },
                {
                    provider_id: "anthropic",
                    model_id: "claude-haiku-4-5",
                    facts: { "window.enforced": fact },
                },
                {
                    provider_id: "anthropic",
                    model_id: "mock-model",
                    facts: { "window.enforced": fact },
                },
            ],
        }),
    );
}

function persistedPressure(harness: ScenarioHarness, sessionId: string): number | null {
    const row = harness
        .contextDb()
        .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { last_context_percentage: number } | null;
    return row?.last_context_percentage ?? null;
}

async function settlePressure(): Promise<void> {
    await Bun.sleep(300);
}

forEachHost(import.meta.url, "same-path Fusiform overlay reload", (host) => {
    let h: ScenarioHarness;
    let overlayRoot: string;
    let overlayPath: string;

    beforeAll(async () => {
        const testRoot = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        if (!testRoot) throw new Error("test preload did not install MAGIC_CONTEXT_TEST_DATA_DIR");
        overlayRoot = mkdtempSync(join(testRoot, "mc-overlay-reload-"));
        overlayPath = join(overlayRoot, "window-overlay.json");
        writeOverlay(overlayPath, 100_000);
        h = await createScenarioHarness(host, {
            magicContextConfig: {
                models: { window_overlay_path: overlayPath },
                execute_threshold_percentage: 80,
            },
            modelContextLimit: 200_000,
        });
    });

    afterAll(async () => {
        await h?.dispose();
        rmSync(overlayRoot, { recursive: true, force: true });
    });

    it("refreshes Pi on a hot extension reload and OpenCode on restart", async () => {
        const usage = {
            input_tokens: 20_000,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        h.mock.setDefault({ text: "ok", usage });
        const sessionId = await createSessionAndPrompt(h, "initial overlay probe");
        await settlePressure();
        expect(persistedPressure(h, sessionId)).toBe(INITIAL_PRESSURE);

        writeOverlay(overlayPath, 160_000);
        await h.sendPrompt(sessionId, "same-path rewrite probe");
        await settlePressure();
        const stalePressure = persistedPressure(h, sessionId);

        await h.reloadPlugin();
        await h.sendPrompt(sessionId, "reloaded overlay probe");
        await settlePressure();
        expect(persistedPressure(h, sessionId)).toBe(RELOADED_PRESSURE);
        expect(stalePressure).toBe(INITIAL_PRESSURE);
    }, 300_000);
});
