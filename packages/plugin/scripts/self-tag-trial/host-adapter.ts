import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// Resolve the cross-package test helper at runtime so the plugin's script
// typecheck does not pull the entire e2e/Pi workspace under its rootDir.
const harnessPath = resolve(import.meta.dir, "../../../e2e-tests/src/harness.ts");
const { TestHarness } = await import(harnessPath);
type MockResponse = { text?: string; content?: unknown[]; stop_reason?: "end_turn" | "tool_use"; usage?: { input_tokens: number; output_tokens: number } };
import type { Variant } from "./engine";
import { forbiddenOpenPaths } from "./bootstrap";

export interface ModelCaller {
    send(prompt: string): Promise<unknown[]>;
    flush(): Promise<unknown[]>;
    close(): Promise<void>;
}

// OpenCode handles provider messages and tool execution. The capture plugin
// calls the built Magic Context hooks instead of simulating their message transformations.
export class OpenCodeCaller implements ModelCaller {
    private offset = 0;
    private constructor(readonly harness: any, readonly capture: string, readonly liveHome: string) {}
    static async mock(root: string, variant: Variant, liveHome: string): Promise<OpenCodeCaller> {
        const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
        if (version !== "1.18.30") throw new Error(`Expected OpenCode 1.18.30, got ${version}`);
        process.env.MC_E2E_PLUGIN_ENTRY = resolve(import.meta.dir, "host-plugin.mjs");
        process.env.SELF_TAG_DIST = resolve(import.meta.dir, "../../dist/index.js");
        process.env.SELF_TAG_VARIANT = variant;
        process.env.SELF_TAG_CAPTURE = join(root, `capture-${variant}.jsonl`);
        const h = await TestHarness.create({
            magicContextConfig: { prompt: { preset: "full" }, dreamer: { disable: true },
                compressor: { enabled: false }, memory: { auto_promote: false, auto_search: { enabled: false } },
                historian: { disable: true } },
        });
        h.mock.addMatcher((body: Record<string, unknown>) => JSON.stringify(body.system ?? "").includes("title generator")
            ? { text: "Fixture trial", usage: { input_tokens: 10, output_tokens: 2 } } : null);
        return new OpenCodeCaller(h, process.env.SELF_TAG_CAPTURE, liveHome);
    }
    session = "";
    async start(): Promise<void> { this.session = await this.harness.createSession(); }
    script(responses: MockResponse[]): void { this.harness.mock.script(responses); }
    async send(prompt: string): Promise<unknown[]> {
        await this.harness.sendPrompt(this.session, prompt, { timeoutMs: 60000 });
        return this.events();
    }
    async flush(): Promise<unknown[]> {
        const count = this.harness.requests().length;
        await this.harness.client.session.prompt({ path: { id: this.session }, body: {
            model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
            parts: [{ type: "text", text: "__SELF_TAG_FLUSH_ONLY__" }],
        } });
        if (this.harness.requests().length !== count) throw new Error("Flush invoked mock provider");
        const events = this.events();
        if (!(events as any[]).some(e => e.kind === "flush")) throw new Error("Flush transform did not execute");
        return events;
    }
    private events(): unknown[] {
        const lines = readFileSync(this.capture, "utf8").trim().split("\n");
        const events = lines.slice(this.offset).map(line => JSON.parse(line));
        this.offset = lines.length;
        return events;
    }
    isolation(): { pid: number; dataDir: string; forbidden: string[]; lsof: string } {
        const pid = this.harness.opencode.pid;
        if (!pid) throw new Error("Missing host pid");
        const lsof = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
        const forbidden = forbiddenOpenPaths(lsof, this.liveHome);
        if (forbidden.length) throw new Error(`Live paths opened: ${forbidden}`);
        if (!this.harness.dataDir.startsWith(process.env.TMPDIR! + "/")) throw new Error("Host data escaped trial root");
        return { pid, dataDir: this.harness.dataDir, forbidden, lsof };
    }
    async close(): Promise<void> { await this.harness.dispose(); }
}
