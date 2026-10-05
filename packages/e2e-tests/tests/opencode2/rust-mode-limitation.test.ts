import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function eventually<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = read();
        if (value !== undefined) return value;
        await Bun.sleep(25);
    }
    throw new Error("timed out waiting for the v2 RPC surface");
}

/**
 * Issue 492 finding 6 used to be a declared limitation: `transform_mode: "rust"` had no wiring on
 * OpenCode 2, so the adapter downgraded it to TypeScript and named `MC-S06` on every status
 * surface for the life of the process. OpenCode 2 now builds the same subc module client the
 * OpenCode 1 lane builds, so the setting is honoured and the limitation is retired.
 *
 * What this test pins is the retirement, with the module deliberately unreachable: the mode is not
 * downgraded, `MC-S06` is never printed, and neither status surface names a limitation this host no
 * longer has. The surfaces instead report that the module could not be read, which is what OpenCode
 * 1 already does in the same situation — `loadRustSessionStatus` and the guard that turns a missing
 * read into that message are shared by both lanes, and the module is the authority for canonical
 * session state. Answering with host-side numbers would state a session state that contradicts the
 * bytes actually being served.
 *
 * That the module DOES serve the transform when one is running is proven against a live module by
 * `rust-mode-module-served.test.ts`.
 */
test("v2 accepts Rust mode without naming a host limitation", async () => {
    const host = await spawnOpencode2({
        magicContextConfig: {
            transform_mode: "rust",
            // `resolveTransformMode` downgrades Rust to TypeScript before the adapter ever sees it
            // unless user-tier subc routing is configured, and the fixture config file IS the user
            // tier. Without this the config loader answers the question and the adapter's own
            // handling of Rust mode is never exercised. The file is deliberately absent: what this
            // test checks is the status surfaces, not a live module.
            subc: { connection_file: "/tmp/mc-e2e-subc-that-is-never-dialled.json" },
            memory: { enabled: false },
            historian: { disable: true },
            dreamer: { disable: true },
        },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        host.mock.setDefault({
            text: "rust-mode fixture reply",
            usage: { input_tokens: 137, output_tokens: 11 },
        });
        await client.session.prompt({ sessionID: session.id, text: "rust mode fixture prompt" });
        await client.session.wait(
            { sessionID: session.id },
            { signal: AbortSignal.timeout(20_000) },
        );

        // The transform still ran: the request reached the provider and the session was measured.
        expect(host.mock.requests().length).toBeGreaterThan(0);

        const storageDir = join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context");
        const discovery = await eventually(() => {
            const directory = rpcPortDir(storageDir, host.cwd);
            if (!existsSync(directory)) return undefined;
            const file = readdirSync(directory).find(
                (name) => name.startsWith("port-") && name.endsWith(".json"),
            );
            return file
                ? (JSON.parse(readFileSync(join(directory, file), "utf8")) as RpcPortFileRecord)
                : undefined;
        });
        const rpc = async (method: string) => {
            const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/${method}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${discovery.token}`,
                },
                body: JSON.stringify({ sessionId: session.id, directory: host.cwd }),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as Record<string, unknown>;
        };

        // Rust mode is running, so the module owns canonical session state. With no
        // module reachable, both surfaces say exactly that rather than inventing one.
        // Reaching this branch at all is itself the proof that the configured mode
        // survived setup: a downgraded session takes the TypeScript branch, which
        // never consults a module and never produces this message.
        const snapshot = await rpc("sidebar-snapshot");
        expect(snapshot.error).toBe(
            "Rust module status unavailable; canonical session state was not read",
        );
        expect(JSON.stringify(snapshot)).not.toContain("rust_mode_unsupported");

        const detail = await rpc("status-detail");
        expect(detail.error).toBe(
            "Rust module status unavailable; canonical session state was not read",
        );
        expect(JSON.stringify(detail)).not.toContain("rust_mode_unsupported");

        // The retired code must not be printed at all: it no longer describes this host.
        const logged = `${host.stdout()}\n${host.stderr()}`
            .split("\n")
            .filter((line) => line.includes("MC-S06"));
        expect(logged).toEqual([]);
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
    }
}, 90_000);
