import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { MockProvider } from "../src/mock-provider/server";
import { createIsolatedEnv, PLUGIN_ENTRY, spawnOpencode } from "../src/opencode-runner/spawn";

test("OpenCode 1.18.30 custom protected tool keeps newest two through emergency", async () => {
    const taskRoot = join(tmpdir(), "magic-context", "protected-tools");
    mkdirSync(taskRoot, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = taskRoot;
    const env = createIsolatedEnv();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    const root = dirname(env.dataDir);
    expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
    const fixture = join(root, "custom-plugin.ts");
    const toolModule = resolve(import.meta.dir, "../../plugin/node_modules/@opencode-ai/plugin/dist/tool.js");
    writeFileSync(fixture, `import { tool } from ${JSON.stringify(toolModule)};
        export default async () => ({ tool: { custom: tool({ description: "Return deterministic inspection output", args: { n: tool.schema.number() }, async execute({n}) { return "CUSTOM_RESULT_" + n + "\\n" + Array.from({length:2000}, (_,i) => ((i*7919+n*104729).toString(16)+":"+(i*3571).toString(16)+"!")).join(" "); } }) } });`);
    const mock = new MockProvider();
    const { baseURL } = await mock.start();
    let host: Awaited<ReturnType<typeof spawnOpencode>> | undefined;
    try {
        // CI installs the newest OpenCode 1.x; the behaviour under test is not version-specific.
        expect(execFileSync("timeout", ["10s", "opencode", "--version"], { encoding: "utf8" }).trim()).toMatch(/^1\.\d+\.\d+$/);
        host = await spawnOpencode({
            mockProviderURL: baseURL, existingEnv: env, modelContextLimit: 100000,
            openCodeConfigExtra: { plugin: [`file://${PLUGIN_ENTRY}`, `file://${fixture}`] },
            magicContextConfig: { protected_tools: { MCP_CUSTOM: 2 }, output_reserve: 0, execute_threshold_percentage: 65,
                historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false }, embedding: { provider: "off" } },
        });
        const containment = () => {
            const inventory = execFileSync("timeout", ["10s", "lsof", "-nP", "-p", String(host!.pid), "-Fn"], { encoding: "utf8" });
            const paths = inventory.split("\n").filter(line => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map(line => line.slice(1));
            expect(paths.length).toBeGreaterThan(0);
            expect(paths.every(path => path.startsWith(root + "/"))).toBe(true);
            writeFileSync(join(root, "lsof.txt"), inventory);
            console.log(`protected_tools lsof: ${JSON.stringify(paths)}`);
        };
        containment();
        let issued = false;
        mock.addMatcher(body => {
            if (JSON.stringify(body.system).includes("title generator")) return { text: "Protected tools", usage: { input_tokens: 100, output_tokens: 5 } };
            if (!issued) {
                issued = true;
                return { content: [1,2,3,4].map(n => ({ type: "tool_use" as const, id: `custom-${n}`, name: "custom", input: { n } })), stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 } };
            }
            return { text: "Done", usage: { input_tokens: 96000, output_tokens: 10 } };
        });
        const client = createOpencodeClient({ baseUrl: host.url });
        const session = await client.session.create({ query: { directory: env.workdir } });
        const id = session.data?.id;
        if (!id) throw new Error("Session missing");
        const prompt = (text: string) => client.session.prompt({ path: { id }, body: { model: { providerID: "mock-anthropic", modelID: "mock-sonnet" }, parts: [{ type: "text", text }] } });
        expect((await prompt("Call the custom tool four times")).error).toBeUndefined();
        const start = mock.requests().length;
        expect((await prompt("EMERGENCY_PROTECTED_TOOLS inspect again")).error).toBeUndefined();
        const captured = mock.requests().slice(start).filter(request => JSON.stringify(request.body.messages).includes("EMERGENCY_PROTECTED_TOOLS"));
        expect(captured.length).toBeGreaterThan(0);
        const wire = JSON.stringify(captured.at(-1)!.body.messages);
        expect(wire).toContain("CUSTOM_RESULT_4");
        expect(wire).toContain("CUSTOM_RESULT_3");
        expect(wire).not.toContain("CUSTOM_RESULT_2");
        expect(wire).not.toContain("CUSTOM_RESULT_1");
        const logPath = join(env.dataDir, "cortexkit", "magic-context-e2e.log");
        // Provider completion can precede the asynchronous diagnostic append.
        // Observe its file event before killing the host instead of racing the log.
        await new Promise<void>((resolveLog, rejectLog) => {
            const watcher = watch(logPath, () => {
                if (readFileSync(logPath, "utf8").includes("emergency tiered drop:")) finish();
            });
            const timer = setTimeout(() => finish(new Error("Emergency diagnostic did not flush")), 10000);
            const finish = (error?: Error) => {
                watcher.close(); clearTimeout(timer);
                if (error) rejectLog(error); else resolveLog();
            };
            if (readFileSync(logPath, "utf8").includes("emergency tiered drop:")) finish();
        });
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("emergency tiered drop:");
        console.log("protected_tools emergency lane confirmed in host log; newest two visible, third-newest removed");
        containment();
    } finally { await host?.kill(); await mock.stop(); }
}, 180000);
