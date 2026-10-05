// Isolate npm's startup from registry network latency using a local registry.
// No doctor output or registry-resolution behavior is changed by this probe.
// timeout 180 bun .../npm-probe.ts <throwaway-root>
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
mkdirSync(root, { recursive: true });
const emptyConfig = join(root, "empty.npmrc");
writeFileSync(emptyConfig, "");
const globalConfig = join(root, "global.npmrc");
writeFileSync(globalConfig, "");
const pkg = "@cortexkit/magic-context";
let requests = 0;
const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
        requests++;
        return Response.json(new URL(request.url).pathname.endsWith("/latest")
            ? { version: "1.2.3" }
            : { name: pkg, "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: pkg, version: "1.2.3" } } });
    },
});
const env = {
    ...process.env, HOME: root, XDG_CONFIG_HOME: root,
    npm_config_registry: server.url.href,
    npm_config_cache: join(root, "cache"),
    npm_config_userconfig: emptyConfig, npm_config_globalconfig: globalConfig,
};
const run = promisify(execFile);
try {
    const version = await run("npm", ["--version"], { cwd: root, env, timeout: 10000 });
    console.log(`Bun ${Bun.version}; npm ${version.stdout.trim()}`);
    for (let pass = 0; pass < 3; pass++) {
        const start = performance.now();
        const result = await run("npm", ["view", pkg, "version"], { cwd: root, env, timeout: 10000 });
        if (result.stdout.trim() !== "1.2.3") throw new Error("npm fixture not reached");
        const npmMs = performance.now() - start;
        const direct = performance.now();
        const response = await fetch(`${server.url}${pkg}/latest`);
        const body = await response.json() as { version: string };
        if (body.version !== "1.2.3") throw new Error("HTTP fixture not reached");
        console.log(JSON.stringify({ pass, npmMs, fetchMs: performance.now() - direct, requests }));
    }
} finally {
    server.stop(true);
}
