import { TestHarness } from "../../src/harness";
import { runValidatedHistorianPass } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../../plugin/src/hooks/magic-context/compartment-prompt";
import { calibrationChunk, calibrationOutput, calibrationPrompt } from "./calibration-s3-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "../../../plugin/node_modules/@opencode/client/dist/promise/client.js";
import { spawnOpencode2 } from "../../src/opencode2-runner/spawn";

async function proof(run: (host: Awaited<ReturnType<typeof spawnOpencode2>>, client: ReturnType<typeof OpenCode.make>, sessionID: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "mc-s3-plugin-"));
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "hidden-s3-probe.ts")], outdir: root, naming: "index.js", target: "node", format: "esm", define: { "process.env.NODE_ENV": '"production"' }, external: ["bun:sqlite", "node:sqlite"] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const host = await spawnOpencode2({ probePlugin: root });
    try {
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        await client.plugin.awaitActivation({ location: { directory: host.cwd } }, { signal: AbortSignal.timeout(15000) });
        host.mock.setDefault({ text: "real host answer", usage: { input_tokens: 100, output_tokens: 10 } });
        for (const text of ["first source turn", "protected source turn"]) {
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
        }
        await run(host, client, session.id);
    } catch (error) { console.error(host.stderr().slice(-6000)); throw error; }
    finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
}
const capture = (cwd: string) => JSON.parse(readFileSync(join(cwd, "s3-proof.json"), "utf8"));
async function trigger(client: ReturnType<typeof OpenCode.make>, sessionID: string, prompt: string) {
    await expect(client.session.generate({ sessionID, prompt }, { signal: AbortSignal.timeout(25000) })).rejects.toThrow();
}

test("R36 real GA historian publishes via generate without creating a session row", async () => {
    await proof(async (host, client, sessionID) => {
        const sessionsBefore = await client.session.list({ directory: host.cwd });
        const before = host.mock.requests().length;
        host.mock.setDefault({ text: '<compartment start="1" end="2" title="Real historian"><p1>First source turn and answer preserved.</p1></compartment>', usage: { input_tokens: 100, output_tokens: 10 } });
        await trigger(client, sessionID, "S3_HISTORIAN");
        const result = capture(host.cwd);
        expect(result.compartments).toHaveLength(1);
        expect(result.compartments[0].title).toBe("Real historian");
        expect(result.runs).toEqual([{ harness: "opencode2", status: "success" }]);
        expect(result.markers).toEqual([]);
        expect(host.mock.requests().length - before).toBe(1);
        expect(await client.session.list({ directory: host.cwd })).toEqual(sessionsBefore);
        const body = host.mock.requests().at(-1)!.body;
        expect(JSON.stringify(body)).toContain("Messages 1-2:");
        expect(JSON.stringify(body)).not.toContain("protected source turn");
    });
}, 60000);

test("R37 real GA configured differing model refuses with zero provider requests", async () => {
    await proof(async (host, client, sessionID) => {
        const before = host.mock.requests().length;
        await trigger(client, sessionID, "S3_MODEL_REFUSE");
        expect(capture(host.cwd).code).toBe("hidden_model_unsupported");
        expect(host.mock.requests()).toHaveLength(before);
    });
}, 60000);

test("R38 real GA tools-required dream task refuses before dispatch", async () => {
    await proof(async (host, client, sessionID) => {
        const before = host.mock.requests().length;
        await trigger(client, sessionID, "S3_TOOLS_REFUSE");
        const result = capture(host.cwd);
        expect(result.result.status).toBe("failed");
        expect(result.dispatches).toBe(0);
        expect(result.result.error).toContain("hidden_tools_unsupported");
        expect(result.rows[0].tasks_failed).toBe(1);
        expect(result.rows[0].tasks_succeeded).toBe(0);
        expect(host.mock.requests()).toHaveLength(before);
    });
}, 60000);

test("R34 real GA warming-shaped generate stays byte-untouched", async () => {
    await proof(async (host, client, sessionID) => {
        const before = host.mock.requests().length;
        await client.session.generate({ sessionID, prompt: "S3_WARMING" }, { signal: AbortSignal.timeout(15000) });
        const result = capture(host.cwd);
        expect(result.before).toBe(result.after);
        expect(host.mock.requests().length - before).toBe(1);
        expect(JSON.stringify(host.mock.requests().at(-1)!.body)).toContain("protected source turn");
    });
}, 60000);


test("R38 compress-cues executes one metered generate and applies its cue on real GA", async () => {
    await proof(async (host, client, sessionID) => {
        const before = host.mock.requests().length;
        host.mock.addMatcher((body) => {
            const prompt = JSON.stringify(body);
            const match = prompt.match(/\[(\d+)\]/);
            if (!prompt.includes("<cues>") || !match) return null;
            return { text: `<cues><cue id="${match[1]}">stable source ordinals</cue></cues>`, usage: { input_tokens: 100, output_tokens: 10 } };
        });
        await trigger(client, sessionID, "S3_COMPRESS");
        const result = capture(host.cwd);
        expect(result.result.status).toBe("completed");
        expect(result.cues).toEqual([{ mural_cue: "stable source ordinals" }]);
        expect(result.rows[0].tasks_succeeded).toBe(1);
        expect(host.mock.requests().length - before).toBe(1);
    });
}, 60000);


test("R33 calibration: v1 child and v2 own/session-system arms preserve prompt bytes and record validator verdicts", async () => {
    const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const metrics: Record<string, unknown> = {};
    const v1 = await TestHarness.create();
    try {
        const parent = await v1.createSession();
        await v1.sendPrompt(parent, "Calibration parent");
        v1.mock.setDefault({ text: calibrationOutput, usage: { input_tokens: 100, output_tokens: 10 } });
        const result = await runValidatedHistorianPass({ client: v1.client as never, db: v1.contextDb() as never, parentSessionId: parent, sessionDirectory: v1.opencode.env.workdir, prompt: calibrationPrompt, chunk: calibrationChunk, priorCompartments: [], sequenceOffset: 0, dumpLabelBase: "calibration", timeoutMs: 15000, model: "mock-anthropic/mock-sonnet" });
        expect(result.ok).toBe(true);
        const request = v1.mock.requests().filter(request => strings(request.body).includes(calibrationPrompt)).at(-1);
        expect(request).toBeDefined();
        metrics.v1 = { validator: result.ok, promptBytes: Buffer.byteLength(calibrationPrompt), systemBytes: Buffer.byteLength(strings(request!.body.system).join("\n")) };
    } finally { await v1.dispose(); }
    await proof(async (host, client, sessionID) => {
        host.mock.setDefault({ text: calibrationOutput, usage: { input_tokens: 100, output_tokens: 10 } });
        for (const arm of ["OWN", "SESSION"]) {
            const before = host.mock.requests().length;
            await trigger(client, sessionID, `S3_CALIBRATE_${arm}`);
            expect(capture(host.cwd).ok).toBe(true);
            expect(host.mock.requests().length - before).toBe(1);
            const body = host.mock.requests().at(-1)!.body;
            expect(strings(body)).toContain(calibrationPrompt);
            const system = strings(body.instructions ?? body.system).join("\n");
            if (arm === "OWN") expect(system).toBe(COMPARTMENT_AGENT_SYSTEM_PROMPT);
            else expect(system).not.toContain(COMPARTMENT_AGENT_SYSTEM_PROMPT);
            metrics[`v2_${arm.toLowerCase()}`] = { validator: capture(host.cwd).ok, promptBytes: Buffer.byteLength(calibrationPrompt), systemBytes: Buffer.byteLength(system) };
        }
    });
    console.info("R33_CALIBRATION", JSON.stringify(metrics));
}, 120000);
