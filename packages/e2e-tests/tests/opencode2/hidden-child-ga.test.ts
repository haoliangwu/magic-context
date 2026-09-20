import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(20);
    }
}

function responseInputText(body: Record<string, unknown>): string[] {
    const input = body.input;
    if (!Array.isArray(input)) return [];
    return input.flatMap((message) => {
        if (!message || typeof message !== "object") return [];
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? [(part as { text: string }).text]
                : [],
        );
    });
}

test("OpenCode 2 hidden historian uses one reusable cheap-model child and retires failures", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "mc-hidden-child-ga-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-ga-probe.ts")],
        outdir: bundleDir,
        naming: "index.js",
        target: "node",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
        external: ["bun:sqlite", "node:sqlite"],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));

    const host = await spawnOpencode2({
        probePlugin: bundleDir,
        includeMagicContext: false,
        defaultModelID: "mock-model-user",
        additionalModelIDs: ["mock-model-cheap"],
        modelContextLimit: 200_000,
        mockResponse: {
            text: "hidden completion",
            usage: { input_tokens: 101, output_tokens: 11 },
        },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        await waitForPluginActive(client, host.cwd, "mc-hidden-child-ga-proof");
        await waitForFile(join(host.cwd, "hidden-child-ready"));
        const user = await client.session.create({
            title: "user session",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model-user" },
        });

        const command = async (seq: number, temperature?: number) => {
            const resultPath = join(host.cwd, `hidden-child-result-${seq}.json`);
            writeFileSync(
                join(host.cwd, "hidden-child-command.json"),
                JSON.stringify({ seq, parentSessionID: user.id, temperature }),
            );
            await waitForFile(resultPath);
            return JSON.parse(readFileSync(resultPath, "utf8")) as {
                ok: boolean;
                childID: string;
                error?: string;
                completion?: { text: string; usage: Record<string, number> };
            };
        };

        const first = await command(1, 0.25);
        expect(first.ok).toBe(true);
        expect(first.completion).toMatchObject({
            text: "hidden completion",
            usage: { input: 101, output: 11 },
        });
        const firstWire = host.mock
            .requests()
            .find((request) => responseInputText(request.body).includes("EXACT_HISTORIAN_CHUNK_1"));
        expect(firstWire).toBeDefined();
        expect(firstWire?.body.model).toBe("mock-model-cheap");
        expect(firstWire?.body.instructions).toBe("EXACT_HISTORIAN_SYSTEM_1");
        expect(firstWire?.body.input).toEqual([
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "EXACT_HISTORIAN_CHUNK_1" }],
            },
        ]);
        expect(firstWire?.body.tools).toBeUndefined();
        expect(firstWire?.body.temperature).toBe(0.25);
        expect(firstWire?.body.max_output_tokens).toBe(32768);
        expect((await client.session.get({ sessionID: first.childID })).title).toBe(
            "Magic Context historian",
        );

        const second = await command(2);
        expect(second.ok).toBe(true);
        expect(second.childID).toBe(first.childID);
        const rootsAfterReuse = await client.session.list({
            directory: host.cwd,
            parentID: null,
        });
        const hiddenAfterReuse = rootsAfterReuse.data.filter(
            (session) => session.metadata?.magic_context === "hidden-run",
        );
        expect(hiddenAfterReuse.map((session) => session.id)).toEqual([first.childID]);
        const reader = new V2StoreReader(
            gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
        );
        try {
            expect(
                reader
                    .history(first.childID)
                    .filter(
                        (row) =>
                            row.type === "assistant" && row.data.error === undefined,
                    ),
            ).toHaveLength(2);
        } finally {
            reader.close();
        }

        host.mock.setDefault({
            error: {
                status: 400,
                type: "invalid_request_error",
                message: "forced hidden failure",
            },
        });
        const failed = await command(3);
        expect(failed.ok).toBe(false);
        expect(failed.childID).toBe(first.childID);
        expect(failed.error).toContain("forced hidden failure");

        host.mock.setDefault({
            text: "fresh child completion",
            usage: { input_tokens: 202, output_tokens: 22 },
        });
        const third = await command(4);
        expect(third.ok).toBe(true);
        expect(third.childID).not.toBe(first.childID);
        expect(third.completion?.usage).toMatchObject({ input: 202, output: 22 });

        const storedUser = await client.session.get({ sessionID: user.id });
        expect(storedUser.model).toMatchObject({
            providerID: "openai",
            id: "mock-model-user",
        });
        expect(storedUser.tokens).toMatchObject({ input: 0, output: 0 });
        expect(
            host.mock.requests().filter((request) => request.body.model === "mock-model-user"),
        ).toHaveLength(0);
    } catch (error) {
        console.error(host.stdout(), host.stderr(), JSON.stringify(host.mock.requests()));
        throw error;
    } finally {
        await host.stop();
        rmSync(bundleDir, { recursive: true, force: true });
    }
}, 120_000);
