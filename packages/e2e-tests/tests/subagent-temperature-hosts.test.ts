/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostHarness } from "../src/host-harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import type { CapturedRequest } from "../src/mock-provider/server";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import type { PiMockModel } from "../src/pi-runner/spawn";
import { createScenarioHarness, forEachHost, type ScenarioHarness } from "../src/scenario-hosts";
import { cleanupE2ETempDir, createE2ETempDir } from "../src/temp-dir";

/**
 * The historian's configured temperature reaches a model only when model metadata
 * positively says the model accepts it. OpenCode 1 carries models.dev's flag on its
 * own model rows; OpenCode 2 rows and Pi's registry do not, so Magic Context reads
 * the models.dev catalogue OpenCode caches. Each case boots a real host whose model
 * metadata comes from a catalogue copied into its throwaway cache, triggers the
 * historian through context pressure, and reads the temperature the mock received.
 *
 * MC_E2E_MODELS_CATALOG points the run at a real cached catalogue (for example a copy
 * of OpenCode's models.json); otherwise a fixture holding the same entries is used.
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const HISTORIAN_TEMPERATURE = 0.1;

/** Verbatim models.dev entries for every model below, taken from OpenCode's cache. */
const FIXTURE_CATALOG = join(import.meta.dir, "../src/fixtures/models-dev-temperature.json");

interface Case {
    label: string;
    /** OpenCode provider/model, or the Pi historian model. */
    provider: string;
    model: string;
    piApi?: string;
    expected: number | undefined;
}

// The session runs on the default mock model; only the historian is pinned to each
// case's provider/model. OpenCode routes it through the Anthropic wire format so the
// mock can answer; the temperature decision depends only on provider, model id and metadata.
const OPENCODE_CASES: Case[] = [
    { label: "Gemini 3.8 Flash", provider: "google", model: "gemini-3.8-flash", expected: HISTORIAN_TEMPERATURE },
    { label: "Codex GPT-6.1 Sol", provider: "openai", model: "gpt-6.1-sol", expected: undefined },
    { label: "configured head Claude Sonnet 5.5", provider: "anthropic", model: "claude-sonnet-5-5", expected: undefined },
    { label: "configured fallback Muse Spark", provider: "openrouter", model: "meta/muse-spark-1.3-contributor", expected: HISTORIAN_TEMPERATURE },
];

// OpenCode 1 takes Antigravity's flag from the auth plugin's own model definitions,
// which this fixture does not load; OpenCode 2's rows have no flag, so the alias
// must reach the catalog's Gemini entry.
const OPENCODE2_CASES: Case[] = [
    ...OPENCODE_CASES,
    { label: "Antigravity Gemini 3.8 Flash", provider: "google", model: "antigravity-gemini-3.8-flash", expected: HISTORIAN_TEMPERATURE },
];

const PI_CASES: Case[] = [
    { label: "configured head Muse Spark", provider: "openrouter", model: "meta/muse-spark-1.3-contributor", piApi: "openai-completions", expected: HISTORIAN_TEMPERATURE },
    { label: "configured fallback Gemini 3.8 Flash", provider: "openrouter", model: "google/gemini-3.8-flash", piApi: "openai-completions", expected: HISTORIAN_TEMPERATURE },
    { label: "Antigravity Gemini 3.8 Flash", provider: "google-antigravity", model: "gemini-3.8-flash", piApi: "anthropic-messages", expected: HISTORIAN_TEMPERATURE },
    // Pi's real Codex wire needs a ChatGPT login; the Responses wire carries the same provider and model ids.
    { label: "Codex GPT-6.1 Sol", provider: "openai-codex", model: "gpt-6.1-sol", piApi: "openai-responses", expected: undefined },
];

/** Live stores the brief forbids; no host process may hold anything under them. */
const LIVE_ROOTS = [
    join(homedir(), ".local/share/opencode"),
    join(homedir(), ".local/share/cortexkit/magic-context"),
    join(homedir(), ".config/opencode"),
    join(homedir(), ".config/cortexkit"),
    join(homedir(), ".cache/opencode"),
];

function descendants(pid: number): number[] {
    let children: number[] = [];
    try {
        children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
            .map(Number);
    } catch {
        return [];
    }
    return children.flatMap((child) => [child, ...descendants(child)]);
}

/** lsof every process this test spawned and fail on any path inside a live store. */
function assertNoLiveStoreOpen(): { pids: number; paths: number } {
    const pids = descendants(process.pid);
    const paths: string[] = [];
    for (const pid of pids) {
        let inventory = "";
        try {
            inventory = execFileSync("lsof", ["-nP", "-p", String(pid), "-Fn"], { encoding: "utf8" });
        } catch (error) {
            // lsof exits 1 when a short-lived child is already gone.
            inventory = String((error as { stdout?: string }).stdout ?? "");
        }
        for (const line of inventory.split("\n"))
            if (line.startsWith("n/")) paths.push(line.slice(1));
    }
    const live = paths.filter((path) => LIVE_ROOTS.some((root) => path.startsWith(root)));
    expect(live).toEqual([]);
    expect(pids.length).toBeGreaterThan(0);
    return { pids: pids.length, paths: paths.length };
}

function isHistorianRequest(request: CapturedRequest): boolean {
    return JSON.stringify(request.body).includes(HISTORIAN_SYSTEM_MARKER);
}

function pluginLog(h: ScenarioHarness, logPath: string): string {
    if (h instanceof OpenCode2TestHarness) return h.opencode.pluginLog();
    return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

async function triggerHistorian(
    h: HostHarness,
): Promise<{ requests: CapturedRequest[]; trigger: string }> {
    let trigger = "context pressure";
    h.mock.addMatcher((body) => {
        if (!JSON.stringify(body).includes(HISTORIAN_SYSTEM_MARKER)) return null;
        const range = findHistorianOrdinalRange(body);
        return {
            text: range
                ? buildMockHistorianPayload({
                      start: range.start,
                      end: range.end,
                      title: "Temperature probe chunk",
                      body: "Placeholder turns that exist only to start the historian.",
                  })
                : "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
            usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
        };
    });
    const small = { input_tokens: 1_000, output_tokens: 20, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0 };
    h.mock.setDefault({ text: "fill", usage: small });
    const sessionId = await h.createSession();
    // Real text mass: the protected-tail boundary measures content, not mock usage.
    for (let i = 1; i <= 10; i++)
        await h.sendPrompt(sessionId, `turn ${i}: durable signal for chunk ${i}. ${h.ballast(3_000)}`);
    const big = { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000, cache_read_input_tokens: 0 };
    const quiet = { input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 };
    // The pressure event and the next transform pass can race the store's warm-up, so
    // a single spike does not always start the historian. Re-apply pressure until it does.
    for (let attempt = 1; attempt <= 2 && !h.requests().some(isHistorianRequest); attempt++) {
        h.mock.setDefault({ text: "big", usage: big });
        await h.sendPrompt(sessionId, `pressure trigger ${attempt}.`);
        // The trigger waits for an off-thread tag warm-up that restarts whenever the
        // store changes; a quiet moment lets it finish before the next pass.
        await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 1_000 * attempt));
        h.mock.setDefault({ text: "after-trigger", usage: quiet });
        await h.sendPrompt(sessionId, `post-trigger follow-up ${attempt}.`);
        try {
            await h.waitFor(() => h.requests().some(isHistorianRequest), {
                timeoutMs: 15_000,
                label: "historian request reached the mock",
            });
        } catch {
            // Try another pressure round.
        }
    }
    // OpenCode 1's pressure trigger also waits on that warm-up and can starve on a busy
    // machine. Its /ctx-wrapup command runs the same historian agent on demand.
    if (!h.requests().some(isHistorianRequest) && h.host === "opencode" && h.serverUrl) {
        trigger = "ctx-wrapup";
        const response = await fetch(`${h.serverUrl}/session/${sessionId}/command`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
                command: "ctx-wrapup",
                arguments: "",
                agent: "build",
                model: "mock-anthropic/mock-sonnet",
                parts: [],
            }),
        });
        expect(response.ok).toBe(true);
        await h.waitFor(() => h.requests().some(isHistorianRequest), {
            timeoutMs: 60_000,
            label: "wrapup historian request reached the mock",
        });
    }
    expect(h.requests().some(isHistorianRequest)).toBe(true);
    return { requests: h.requests().filter(isHistorianRequest), trigger };
}

forEachHost(import.meta.url, "historian temperature follows model metadata", (host) => {
    const cases = host === "pi" ? PI_CASES : host === "opencode2" ? OPENCODE2_CASES : OPENCODE_CASES;
    let scratch: string;
    let catalog: string;
    const savedLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;

    beforeAll(() => {
        scratch = createE2ETempDir("mc-temperature-hosts-");
        catalog = process.env.MC_E2E_MODELS_CATALOG ?? FIXTURE_CATALOG;
    });

    afterAll(() => {
        if (savedLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
        else process.env.MAGIC_CONTEXT_LOG_PATH = savedLogPath;
        // Honours MC_E2E_KEEP=1, which keeps the per-case plugin logs for inspection.
        cleanupE2ETempDir(scratch);
    });

    for (const testCase of cases) {
        it(
            `${testCase.label} (${testCase.provider}/${testCase.model}) gets ${testCase.expected ?? "no"} temperature`,
            async () => {
                // OpenCode 1 and Pi inherit this; OpenCode 2's isolation names its own log.
                const logPath = join(scratch, `${host}-${testCase.provider}-${testCase.model.replaceAll("/", "_")}.log`);
                process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
                const historian = host === "pi" ? undefined : `${testCase.provider}/${testCase.model}`;
                const piModel: PiMockModel | undefined =
                    host === "pi"
                        ? { provider: testCase.provider, id: testCase.model, api: testCase.piApi ?? "openai-completions" }
                        : undefined;
                const h = await createScenarioHarness(host, {
                    modelsCatalog: catalog,
                    magicContextConfig: {
                        execute_threshold_percentage: 40,
                        historian: { temperature: HISTORIAN_TEMPERATURE },
                    },
                    ...(host === "opencode"
                        ? { historianProviderModel: { providerID: testCase.provider, modelID: testCase.model } }
                        : {}),
                    ...(host === "opencode2"
                        ? {
                              historianProvider: {
                                  providerID: testCase.provider,
                                  modelID: testCase.model,
                                  package: "@opencode/ai/providers/anthropic",
                              },
                          }
                        : {}),
                    ...(piModel ? { historianModel: piModel } : {}),
                });
                try {
                    const { requests, trigger } = await triggerHistorian(h);
                    const isolation = assertNoLiveStoreOpen();
                    const temperatures = requests.map((request) =>
                        "temperature" in request.body ? request.body.temperature : "absent",
                    );
                    // Every case configures a historian temperature, so the plugin logs one
                    // decision per model wherever a temperature reaches it; the log flushes
                    // asynchronously.
                    const decisionLine = () =>
                        pluginLog(h, logPath)
                            .split("\n")
                            .find((line) => line.includes("Subagent temperature"));
                    const decision = await h
                        .waitFor(decisionLine, { timeoutMs: 10_000, label: "temperature decision logged" })
                        .catch(() => undefined);
                    console.log(
                        `[temperature-evidence] ${JSON.stringify({
                            host,
                            model: historian ?? `${piModel?.provider}/${piModel?.id}`,
                            trigger,
                            historianRequests: requests.length,
                            temperatures,
                            decision: decision?.replace(/^.*?(Subagent temperature)/, "$1") ?? null,
                            lsof: isolation,
                        })}`,
                    );
                    expect(requests.length).toBeGreaterThan(0);
                    expect(temperatures).toEqual(requests.map(() => testCase.expected ?? "absent"));
                    if (host === "opencode" && testCase.expected === undefined) {
                        // OpenCode 1 itself leaves agent temperature out of chat.params for a
                        // model whose metadata says no, so there is nothing left to decide.
                        expect(decision ?? "").not.toContain("Subagent temperature sent");
                    } else {
                        expect(decision).toContain(
                            testCase.expected === undefined
                                ? "Subagent temperature omitted"
                                : "Subagent temperature sent",
                        );
                    }
                } finally {
                    await h.dispose();
                }
            },
            240_000,
        );
    }
});
