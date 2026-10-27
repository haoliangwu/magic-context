import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase } from "../../plugin/src/features/magic-context/storage";
import { PiSubagentRunner } from "../src/subagent-runner";
import { MockProvider } from "../../e2e-tests/src/mock-provider/server";

for (const delivery of ["argv", "stdin"] as const) {
    for (const mention of ["internal", "existing-file"] as const) {
        it(`real OMP ${delivery} neutralizes ${mention} mentions`, async () => {
            const parent = join(realpathSync(tmpdir()), "magic-context", "issue-779");
            mkdirSync(parent, { recursive: true });
            const root = mkdtempSync(join(parent, "mentions-"));
            const saved = { ...process.env };
            const mock = new MockProvider();
            closeDatabase();
            try {
                for (const key of Object.keys(process.env)) {
                    if (/API_KEY|TOKEN|CREDENTIAL|SECRET/.test(key)) delete process.env[key];
                }
                for (const key of ["HOME", "CFFIXED_USER_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR", "TMPDIR"]) {
                    process.env[key] = join(root, key.toLowerCase());
                    mkdirSync(process.env[key]!, { recursive: true });
                }
                process.env.OPENCODE_DB = join(root, "opencode.db");
                process.env.PI_OFFLINE = "1";
                process.env.PI_SKIP_VERSION_CHECK = "1";
                delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
                const { baseURL } = await mock.start();
                mock.setDefault({ text: "Copied \u2060@skill://name and plain @agent://foo", usage: { input_tokens: 10, output_tokens: 10 } });
                writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: {
                    mock: { baseUrl: `${baseURL}/v1`, apiKey: "test-key-not-real", api: "anthropic-messages", models: [{
                        id: "mock-model", name: "mock-model", reasoning: false, input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096,
                    }] },
                } }));
                // Match the isolated OMP harness: no plugin package, no xdev, no retries.
                writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "config.yml"), JSON.stringify({
                    tools: { xdev: false, intentTracing: false },
                    defaultProvider: "mock",
                    defaultModel: "mock-model",
                    enabledModels: ["mock/mock-model"],
                    compaction: { enabled: false },
                    retry: { enabled: false },
                    quietStartup: true,
                    enableInstallTelemetry: false,
                }));
                writeFileSync(join(root, "mentioned.txt"), "UNRELATED_FILE_CONTENT_779");
                const manifest = realpathSync(join(import.meta.dir, "../node_modules/omp-coding-agent-1812/package.json"));
                const pkg = JSON.parse(readFileSync(manifest, "utf8"));
                expect(pkg.version).toBe("18.12.3");
                const invocation = { command: process.execPath, prefixArgs: [join(dirname(manifest), pkg.bin.omp)], targetHarness: "omp" as const };
                let pid: number | undefined;
                let isolated = false;
                const inspectFiles = () => {
                    if (!pid) throw new Error("Child PID unavailable");
                    const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
                    const databases = opened.split("\n").filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line)).map((line) => line.slice(1));
                    expect(databases.every((path) => path.startsWith(`${root}/`))).toBe(true);
                    console.log(`OMP ${delivery} ${mention} lsof pid=${pid} databases=${JSON.stringify(databases)}`);
                    isolated = true;
                };
                mock.addMatcher(() => { inspectFiles(); return null; });
                const events: Array<Record<string, unknown>> = [];
                const runner = new PiSubagentRunner({ invocation, platform: delivery === "stdin" ? "win32" : "linux", subagentExtensions: [] });
                const result = await runner.run({
                    agent: "historian", model: "mock/mock-model", systemPrompt: "Reply once with the requested text.",
                    userMessage: mention === "internal" ? "see @skill://name here" : "see @mentioned.txt here",
                    cwd: root, timeoutMs: 30_000,
                    onProgress: (event) => {
                        if (event.type === "spawned") { pid = event.pid; inspectFiles(); }
                        if (event.type === "raw_event") events.push(event.event as Record<string, unknown>);
                    },
                });
                const end = events.find((event) => event.type === "agent_end");
                const messages = end?.messages as Array<{ role: string }> | undefined;
                console.log(`OMP ${pkg.version} ${delivery} ${mention}: ${JSON.stringify({ result, agent_end: !!end, roles: messages?.map((message) => message.role), fileMention: messages?.filter((message) => message.role === "fileMention") })}`);
                expect(isolated).toBe(true);
                expect(result).toMatchObject({ ok: true, assistantText: "Copied @skill://name and plain @agent://foo" });
                expect(end).toBeDefined();
                expect(messages?.some((message) => message.role === "fileMention")).toBe(false);
                expect(JSON.stringify(mock.requests())).not.toContain("UNRELATED_FILE_CONTENT_779");
            } finally {
                closeDatabase();
                await mock.stop();
                for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
                Object.assign(process.env, saved);
                rmSync(root, { recursive: true, force: true });
            }
        }, 60_000);
    }
}
