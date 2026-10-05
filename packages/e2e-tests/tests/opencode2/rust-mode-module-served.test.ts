/// <reference types="bun-types" />

/**
 * Rust transform mode on a real OpenCode 2 host with a real `ck-mc` module.
 *
 * The OpenCode 1 rust lane proves the module serves transforms, but it boots the
 * 1.x host. This boots the GA 2.0.5 host against the same hermetic daemon and
 * module, which is the only place the OpenCode 2 adapter's own seams meet
 * something that answers: the subc client this lane builds, the raw provider
 * backed by the v2 store, and the boundary the adapter records in place of the
 * compaction row this host cannot write.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();

/** One `rust pass:` diagnostic line, reduced to the fields this lane reads. */
interface PassLine {
    decision: string;
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
}

function field(body: string, name: string): string {
    return new RegExp(`\\b${name}=([^\\s]+)`).exec(body)?.[1] ?? "";
}

function logLines(logPath: string, marker: string): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(marker))
        .map((line) => line.slice(line.indexOf(marker) + marker.length));
}

function readPasses(logPath: string): PassLine[] {
    return logLines(logPath, "rust pass: ").map((body) => ({
        decision: field(body, "decision"),
        servedFrom: field(body, "served_from"),
        inputCount: Number(field(body, "in") || "0"),
        outputCount: Number(field(body, "out") || "0"),
        applied: field(body, "applied") === "true",
    }));
}

/** `rust input coverage: oc_input=N marker_at=… covered=N` — the trim's own trace. */
function readCoverage(logPath: string): Array<{ ocInput: number; markerAt: string }> {
    return logLines(logPath, "rust input coverage: ").map((body) => ({
        ocInput: Number(field(body, "oc_input") || "0"),
        markerAt: field(body, "marker_at"),
    }));
}

/** The plugin buffers its diagnostic log, so a read straight after a turn can miss it. */
async function waitForPasses(logPath: string, atLeast: number): Promise<PassLine[]> {
    const deadline = Date.now() + 60_000;
    let passes = readPasses(logPath);
    while (passes.length < atLeast && Date.now() < deadline) {
        await Bun.sleep(250);
        passes = readPasses(logPath);
    }
    return passes;
}

/**
 * The array this request actually put on the wire.
 *
 * The OpenCode 2 lane's mock speaks the OpenAI Responses API, which carries the
 * conversation in `input`; the Anthropic-shaped lanes carry it in `messages`.
 * Reading whichever is present keeps the assertions about served bytes rather
 * than about one provider's field name — and throwing when neither is present
 * is deliberate, because an empty read would otherwise let every byte-identity
 * assertion below pass by comparing nothing to nothing.
 */
function servedArray(request: { body: Record<string, unknown> } | undefined): unknown[] {
    const wire = request?.body.input ?? request?.body.messages;
    if (!Array.isArray(wire) || wire.length === 0) {
        throw new Error(
            `no served array on the captured request; body keys: ${Object.keys(request?.body ?? {}).join(", ") || "<no request>"}`,
        );
    }
    return wire;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!prereqs.ok)(
    `rust mode on OpenCode 2${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
    () => {
        let host: Awaited<ReturnType<typeof spawnOpencode2>>;
        let subc: HermeticSubcStack;
        let client: ReturnType<typeof OpenCode.make>;
        let sessionID: string;
        let logPath: string;

        beforeAll(async () => {
            const fixture = isolation();
            logPath = join(fixture.env.XDG_DATA_HOME!, "magic-context-oc2-rust.log");
            fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
            const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
            subc = await HermeticSubcStack.start({
                dataDir: fixture.env.XDG_DATA_HOME!,
                ckMcBin: binaries.ckMcBin,
                ckSubcBin: binaries.ckSubcBin,
                startProducer: true,
            });
            host = await spawnOpencode2({
                existingIsolation: fixture,
                magicContextConfig: {
                    transform_mode: "rust",
                    subc: { connection_file: subc.connectionFile },
                    memory: { enabled: false },
                    dreamer: { disable: true },
                },
            });
            client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            const session = await client.session.create({
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            sessionID = session.id;
        }, 600_000);

        afterAll(async () => {
            await host?.stop();
            await subc?.stop();
        });

        it("serves the transform from the module, not the TypeScript pipeline", async () => {
            for (let turn = 1; turn <= 3; turn += 1) {
                host.mock.setDefault({
                    text: `assistant ${turn}`,
                    usage: { input_tokens: 10_000 * turn, output_tokens: 20 },
                });
                await client.session.prompt({
                    sessionID,
                    text: `turn ${turn}: ${"ballast ".repeat(200)}`,
                });
                await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
            }

            // Precondition: the turns really reached the provider. Without this the
            // assertions below could pass on an empty run.
            expect(host.mock.requests().length).toBeGreaterThan(0);
            const served = servedArray(host.mock.requests().at(-1));
            expect(served.length).toBeGreaterThan(0);

            // The `rust pass:` line is written only by createRustModeTransform, so its
            // presence is the proof that this host routed through the module rather
            // than building the TypeScript transform. `served_from=transform` is the
            // module's own verdict that it produced the bytes.
            const passes = await waitForPasses(logPath, 1);
            expect(passes.length).toBeGreaterThan(0);
            expect(passes.some((pass) => pass.servedFrom === "transform" && pass.applied)).toBe(
                true,
            );
            expect(passes.every((pass) => pass.decision !== "parked")).toBe(true);
            // m[0] is the module's composed head, and it is what the host sends first.
            expect(JSON.stringify(served[0])).toContain("<session-history>");
        }, 900_000);

        it("keeps m[0] byte-identical across passes that do not re-render", async () => {
            const digests: string[] = [];
            for (let turn = 1; turn <= 4; turn += 1) {
                await client.session.prompt({ sessionID, text: `defer ${turn}` });
                await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
                const head = servedArray(host.mock.requests().at(-1))[0];
                // Guard against hashing an absent head: sha256 of "null" repeats too.
                expect(JSON.stringify(head)).toContain("<session-history>");
                digests.push(sha256(JSON.stringify(head)));
            }
            console.log(
                `m0 sha256 per pass:\n${digests.map((digest, index) => `  pass ${index + 1}: ${digest}`).join("\n")}`,
            );
            expect(new Set(digests).size).toBe(1);
        }, 900_000);

        it("shows module status on the OpenCode 2 status surfaces", async () => {
            const storageDir = join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context");
            const directory = rpcPortDir(storageDir, host.cwd);
            const file = readdirSync(directory).find(
                (name) => name.startsWith("port-") && name.endsWith(".json"),
            );
            const discovery = JSON.parse(
                readFileSync(join(directory, file!), "utf8"),
            ) as RpcPortFileRecord;
            const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/status-detail`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${discovery.token}`,
                },
                body: JSON.stringify({ sessionId: sessionID, directory: host.cwd }),
            });
            expect(response.status).toBe(200);
            const detail = (await response.json()) as Record<string, unknown>;
            // With a module answering, the Rust branch of the status handlers reads
            // canonical session state instead of reporting it unavailable.
            expect(detail.error).toBeUndefined();
            expect(JSON.stringify(detail)).not.toContain("rust_mode_unsupported");
        }, 120_000);
    },
);
