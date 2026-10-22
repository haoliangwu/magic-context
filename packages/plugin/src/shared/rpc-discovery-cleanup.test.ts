import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextRpcServer } from "./rpc-server";
import * as utils from "./rpc-utils";
import { createTestTempDirFromPath } from "./test-temp-dir";

test("RPC startup reaps dead records across projects but keeps live and inconclusive records", async () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "rpc-reap-"));
    const server = new MagicContextRpcServer(root, "/current-project");
    const dir = utils.rpcPortDir(root, "/other-project");
    const empty = utils.rpcPortDir(root, "/empty-project");
    mkdirSync(dir, { recursive: true });
    mkdirSync(empty, { recursive: true });
    for (const pid of [999999, 888888, process.pid])
        writeFileSync(
            join(dir, `port-${pid}.json`),
            JSON.stringify({ port: 1234, pid, token: "do-not-log" }),
        );
    const probe = spyOn(utils, "inspectProcessesAsync").mockResolvedValue({
        pi: { state: "absent", processIds: [] },
        evidence: () => ({ processStartTime: null, commandLine: null, imageName: null }),
        liveness: (pid: number) =>
            pid === 999999 ? "dead" : pid === 888888 ? "inconclusive" : "alive",
    } as Awaited<ReturnType<typeof utils.inspectProcessesAsync>>);
    try {
        await server.start();
        expect(readdirSync(dir).sort()).toEqual(
            [`port-${process.pid}.json`, "port-888888.json"].sort(),
        );
        expect(existsSync(empty)).toBe(false);
    } finally {
        server.stop();
        probe.mockRestore();
        rmSync(root, { recursive: true, force: true });
    }
});

test("RPC stop removes its empty discovery directory but preserves other instances", async () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "rpc-stop-reap-"));
    const first = new MagicContextRpcServer(root, root);
    const second = new MagicContextRpcServer(root, root);
    const directory = utils.rpcPortDir(root, root);
    try {
        await first.start();
        await second.start();
        first.stop();
        expect(readdirSync(directory)).toHaveLength(1);
        second.stop();
        expect(existsSync(directory)).toBe(false);
    } finally {
        first.stop();
        second.stop();
        rmSync(root, { recursive: true, force: true });
    }
});
