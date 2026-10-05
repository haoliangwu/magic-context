/**
 * One throwaway OpenCode 1.18.30 host per scenario, wired to a real provider through the
 * loopback recorder.
 *
 * Every state root the host or Magic Context could touch (HOME, all XDG roots, OPENCODE_DB,
 * MAGIC_CONTEXT_STORAGE_DIR, TMPDIR) lives under the scenario root, and `lsof -p <host pid>`
 * must show every open database inside it. API keys go in the disposable `opencode.json`;
 * subscription bearers go in its disposable `data/opencode/auth.json`. `dispose` deletes
 * the whole root, including any auth state the loaded plugin generated from that bearer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareContextDatabase } from "../prepare-context-db";
import { assertThrowawayRoot, authPluginPath, writeAuthConfig } from "./auth";
import type { AuthPlugin, ProviderRoute } from "./types";

export const EXPECTED_HOST_VERSION = "1.18.30";
const repoRoot = resolve(import.meta.dir, "../../../..");
export const PLUGIN_ENTRY = join(repoRoot, "packages/plugin/dist/index.js");

export function databaseFilesFromLsof(out: string, root: string): string[] {
    const canonicalRoot = realpathSync(root);
    const rows = out.split("\n").filter((line) => /REG/.test(line) && /\.db(?:-|\s|$)/.test(line));
    const paths = rows.map((line) => line.split(/\s+/).slice(8).join(" "));
    if (!paths.length || paths.some((path) => !path.startsWith(`${canonicalRoot}/`) && !path.startsWith(`${root}/`))) {
        throw new Error("Database isolation failed: database handles must be inside the throwaway root");
    }
    return [...new Set(paths.map((path) => path.replace(canonicalRoot, "<root>").replace(root, "<root>")))];
}

export interface HostOptions {
    binary: string;
    root: string;
    route: ProviderRoute;
    apiKey: string;
    recorderBaseURL: string;
    magicContext: Record<string, unknown>;
    /** Optional models.dev catalogue copied into the host cache, so model metadata is current. */
    modelsCatalog?: string;
    authPlugins?: Partial<Record<AuthPlugin, string>>;
}

export interface Host {
    url: string;
    pid: number;
    workDir: string;
    contextDb: string;
    mcLogPath: string;
    hostLog(): string;
    /**
     * Magic Context config warnings logged so far. An invalid value silently falls back to its
     * default, so a scenario that ignored these would measure a different configuration.
     */
    configWarnings(): string[];
    api(path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; value: unknown }>;
    /** Database files the host holds open; throws when any lies outside the scenario root. */
    checkIsolation(): string[];
    dispose(): Promise<void>;
}

function providerConfig(options: HostOptions): Record<string, unknown> {
    const { route } = options;
    return {
        [route.providerId]: {
            npm: route.npm,
            options: {
                ...route.providerOptions,
                ...(!route.authPlugin ? { apiKey: options.apiKey } : {}),
                baseURL: options.recorderBaseURL,
            },
            models: {
                [route.model]: {
                    name: route.model,
                    reasoning: true,
                    tool_call: true,
                    attachment: false,
                    temperature: false,
                    limit: { context: 200_000, output: 8_192 },
                    ...route.modelConfig,
                    options: route.modelOptions ?? {},
                },
            },
        },
    };
}

export async function startHost(options: HostOptions): Promise<Host> {
    assertThrowawayRoot(options.root);
    if (existsSync(options.root)) throw new Error(`Scenario root already exists: ${options.root}`);
    try {
        return await startHostInRoot(options);
    } catch (error) {
        // Startup can fail before a Host exists; still delete its disposable credential file.
        assertThrowawayRoot(options.root);
        rmSync(options.root, { recursive: true, force: true });
        throw error;
    }
}

async function startHostInRoot(options: HostOptions): Promise<Host> {
    const { root, route } = options;
    assertThrowawayRoot(root);
    if (existsSync(root)) throw new Error(`Scenario root already exists: ${root}`);
    const authPath = authPluginPath(route, options.authPlugins);
    const dirs = Object.fromEntries(
        ["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((key) => [key, join(root, key)]),
    ) as Record<string, string>;
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.modelsCatalog) {
        mkdirSync(join(dirs.cache, "opencode"), { recursive: true });
        copyFileSync(options.modelsCatalog, join(dirs.cache, "opencode", "models.json"));
    }
    const model = `${route.providerId}/${route.model}`;
    writeFileSync(
        join(dirs.config, "opencode.json"),
        JSON.stringify({
            plugin: [pathToFileURL(PLUGIN_ENTRY).href, ...(authPath ? [pathToFileURL(authPath).href] : [])],
            provider: providerConfig(options),
            enabled_providers: [route.providerId],
            model,
            small_model: model,
            autoupdate: false,
            share: "disabled",
            compaction: { auto: false, prune: false },
            agent: { title: { disable: true }, summary: { disable: true } },
            permission: { bash: "allow", edit: "deny", webfetch: "deny", external_directory: "deny" },
        }),
        { mode: 0o600 },
    );
    // Current Magic Context reads $XDG_CONFIG_HOME/cortexkit/magic-context.jsonc (the old
    // opencode/ location is migrated there on boot).
    mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
    writeFileSync(
        join(dirs.config, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            dreamer: { disable: true },
            historian: { opencode: { model } },
            ...options.magicContext,
        }),
    );
    prepareContextDatabase(dirs.data);
    const storageDir = join(dirs.data, "cortexkit", "magic-context");
    const mcLogPath = join(root, "mc.log");
    const env: Record<string, string> = {
        PATH: process.env.PATH as string,
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        XDG_RUNTIME_DIR: dirs.runtime,
        OPENCODE_CONFIG_DIR: dirs.config,
        OPENCODE_DB: join(dirs.data, "opencode", "live.db"),
        MAGIC_CONTEXT_STORAGE_DIR: storageDir,
        MAGIC_CONTEXT_LOG_PATH: mcLogPath,
        TMPDIR: dirs.tmp,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        ...writeAuthConfig(root, route, options.apiKey, options.recorderBaseURL),
    };
    const version = Bun.spawnSync([options.binary, "--version"], { env, windowsHide: true }).stdout.toString().trim();
    if (version !== EXPECTED_HOST_VERSION) throw new Error(`Expected OpenCode ${EXPECTED_HOST_VERSION}, got ${version}`);
    const port = 22000 + Math.floor(Math.random() * 20000);
    const child: ChildProcess = spawn(
        options.binary,
        ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
        { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    const url = `http://127.0.0.1:${port}`;

    const api = async (path: string, body: unknown, timeoutMs = 120_000) => {
        const separator = path.includes("?") ? "&" : "?";
        const res = await fetch(`${url}${path}${separator}directory=${encodeURIComponent(dirs.work)}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, value: await res.json().catch(() => null) };
    };

    const checkIsolation = () => {
        const sample = Bun.spawnSync(["lsof", "-p", String(child.pid)], { windowsHide: true });
        if (sample.exitCode !== 0) throw new Error("lsof failed; database isolation is unproven");
        const out = sample.stdout.toString();
        writeFileSync(join(root, "lsof.txt"), out);
        return databaseFilesFromLsof(out, root);
    };

    const dispose = async () => {
        process.off("SIGTERM", terminate);
        process.off("SIGINT", terminate);
        if (child.exitCode === null) {
            child.kill("SIGTERM");
            const exited = await Promise.race([
                new Promise<boolean>((r) => child.once("exit", () => r(true))),
                Bun.sleep(15_000).then(() => false),
            ]);
            if (!exited) {
                child.kill("SIGKILL");
                await new Promise<void>((r) => child.once("exit", () => r()));
            }
        }
        rmSync(root, { recursive: true, force: true });
    };
    const terminate = () => { void dispose().finally(() => process.exit(124)); };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);

    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
        try {
            ready = (await fetch(`${url}/session`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {}
        if (!ready) await Bun.sleep(500);
    }
    if (!ready) {
        await dispose();
        throw new Error(`host did not start: ${logs.slice(-2000)}`);
    }

    return {
        url,
        pid: child.pid as number,
        workDir: dirs.work,
        contextDb: join(storageDir, "context.db"),
        mcLogPath,
        hostLog: () => logs,
        configWarnings: () =>
            readIfExists(mcLogPath)
                .split("\n")
                .filter((line) => line.includes("config warning")),
        api,
        checkIsolation,
        dispose,
    };
}

export function readIfExists(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
