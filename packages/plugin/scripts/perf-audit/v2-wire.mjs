import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../../e2e-tests/src/mock-provider/server";
import {
    assertOpenPaths,
    CLI,
    isolation,
    ROOT_KEYS,
    spawnOpencode2,
    waitForPluginActive,
} from "../../../e2e-tests/src/opencode2-runner/spawn";
import { closeDatabase } from "../../src/features/magic-context/storage-db";

// Pass a preserved pre-change dist/v2/server.js; both arms use the same private
// project path. Compare raw HTTP body text, not a second prompt serializer.
const baseline = process.argv[2];
if (!baseline)
    throw new Error("Usage: timeout 600 bun scripts/perf-audit/v2-wire.mjs <baseline-server.js>");
const candidate = resolve(import.meta.dir, "../../dist/v2/server.js");
const fixture = isolation();
const version = spawnSync(CLI, ["--version"], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
    timeout: 30_000,
});
assert.equal(version.status, 0);
assert.equal(version.stdout.trim().replace(/^opencode v/, ""), "2.0.22");
console.log(`bun=${Bun.version} OpenCode=${version.stdout.trim()} throwaway=${fixture.root}`);
let sessionID;
const stores = [
    join(fixture.env.XDG_DATA_HOME, "opencode/opencode2.db"),
    join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR, "context.db"),
];

async function capture(entry, arm) {
    const mock = new MockProvider();
    mock.setDefault({ text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } });
    let reply = 0;
    mock.addMatcher((body) =>
        JSON.stringify(body).includes("PERF-WIRE")
            ? {
                  openaiOutput: [
                      {
                          id: `msg_perf_reply_${++reply}`,
                          type: "message",
                          role: "assistant",
                          content: [
                              {
                                  type: "output_text",
                                  text: "fixture reply",
                                  annotations: [],
                                  logprobs: [],
                              },
                          ],
                      },
                  ],
                  usage: { input_tokens: 100, output_tokens: 10 },
              }
            : null,
    );
    const upstream = await mock.start();
    const probe = join(fixture.root, `probe-${arm}`);
    mkdirSync(probe);
    writeFileSync(
        join(probe, "server.js"),
        `
        import mc from ${JSON.stringify(resolve(entry))};
        export default { id: 'opencode-magic-context', async setup(context) {
            const dispose = await mc.setup(context);
            await context.command.transform(editor => editor.add({name:'perf-synthetic',execute:async ({sessionID})=>{
                const id='msg_perf_wire_synthetic';
                await context.storage.set('synthetic/'+sessionID+'/'+id,{id});
                await context.session.synthetic({sessionID,id,text:'PERF-WIRE admitted reminder',delivery:'steer'});
            }}));
            return dispose;
        }};
    `,
    );
    let host;
    try {
        host = await spawnOpencode2({
            existingIsolation: fixture,
            existingMock: { mock, baseURL: upstream.baseURL },
            includeMagicContext: false,
            probePlugin: probe,
            compactionAuto: false,
            magicContextConfig: {
                auto_update: false,
                temporal_awareness: false,
                dreamer: { disable: true, inject_docs: false },
                historian: { disable: true },
                memory: { enabled: false },
                compressor: { enabled: false },
            },
        });
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        await waitForPluginActive(client, fixture.cwd);
        if (arm === "baseline") {
            const session = await client.session.create({
                title: "Wire identity",
                location: { directory: fixture.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            sessionID = session.id;
            // The host's cache key is its session id. Reuse the pre-turn stores,
            // rather than normalizing that field out of the captured HTTP bytes.
            closeDatabase();
            for (let i = 0; i < stores.length; i++) {
                const db = new Database(stores[i], { readonly: true });
                try {
                    db.query("VACUUM INTO ?").run(join(fixture.root, `initial-${i}.db`));
                } finally {
                    db.close();
                }
            }
        }
        const prompt = async (text) => {
            await client.session.prompt({ sessionID, text });
            await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
        };
        await prompt("PERF-WIRE first turn");
        await prompt("PERF-WIRE defer turn");
        await client.session.command({ sessionID, name: "perf-synthetic", text: "" });
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
        await prompt("PERF-WIRE after synthetic");
        await client.session.command({ sessionID, name: "ctx-flush", text: "" });
        await prompt("PERF-WIRE priced flush");
        const fds = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], {
            encoding: "utf8",
            timeout: 30_000,
        });
        assert.equal(fds.status, 0);
        const paths = fds.stdout
            .split("\n")
            .filter((line) => line.startsWith("n"))
            .map((line) => line.slice(1));
        assertOpenPaths(paths, fixture.root);
        console.log(
            `${arm} lsof databases=${JSON.stringify([...new Set(paths.filter((path) => /\.db(-wal|-shm)?$/.test(path)))])}`,
        );
        const bodies = mock
            .requests()
            .map((request) => request.rawBody)
            .filter((body) => body.includes("PERF-WIRE"));
        assert.ok(bodies.length >= 5, `Expected provider requests in ${arm}, got ${bodies.length}`);
        assert.ok(
            bodies.some((body) => body.includes("admitted reminder")),
            "Synthetic never reached the provider",
        );
        return bodies;
    } catch (error) {
        console.error(
            `${arm} failed after ${mock.requests().length} captured requests`,
            error,
            host?.stderr().slice(-4000),
        );
        throw error;
    } finally {
        await host?.stop();
        await mock.stop();
        closeDatabase();
    }
}

try {
    const before = await capture(baseline, "baseline");
    for (const key of ROOT_KEYS) {
        rmSync(fixture.env[key], { recursive: true, force: true });
        mkdirSync(fixture.env[key]);
    }
    for (let i = 0; i < stores.length; i++) {
        mkdirSync(resolve(stores[i], ".."), { recursive: true });
        copyFileSync(join(fixture.root, `initial-${i}.db`), stores[i]);
    }
    const after = await capture(candidate, "candidate");
    assert.equal(after.length, before.length, "Provider request count changed");
    for (let i = 0; i < before.length; i++) {
        if (after[i] !== before[i]) {
            let offset = 0;
            while (
                offset < Math.min(after[i].length, before[i].length) &&
                after[i][offset] === before[i][offset]
            )
                offset++;
            throw new Error(
                `Provider raw body differs at request ${i}, offset ${offset}: before=${before[i].slice(Math.max(0, offset - 80), offset + 200)} after=${after[i].slice(Math.max(0, offset - 80), offset + 200)}`,
            );
        }
        console.log(
            `wire request=${i} bytes=${Buffer.byteLength(after[i])} sha256=${createHash("sha256").update(after[i]).digest("hex")} identical`,
        );
    }
    console.log(`PASS: ${after.length} actual OpenCode 2.0.22 provider HTTP bodies byte-identical`);
} finally {
    rmSync(fixture.root, { recursive: true, force: true });
}
