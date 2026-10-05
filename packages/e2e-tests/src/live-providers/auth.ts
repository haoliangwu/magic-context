/** Disposable auth-plugin configuration. No operator config or login store is consulted. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { AuthPlugin, ProviderRoute } from "./types";

export function assertThrowawayRoot(root: string): void {
    const base = resolve(tmpdir(), "magic-context");
    if (!resolve(root).startsWith(`${base}${sep}`)) throw new Error("Use a root beneath $TMPDIR/magic-context/");
}

export function authPluginPath(route: ProviderRoute, plugins: Partial<Record<AuthPlugin, string>> = {}): string | null {
    if (!route.authPlugin) return null;
    const path = plugins[route.authPlugin];
    if (!path || !isAbsolute(path) || !existsSync(path)) {
        throw new Error(`Supply the existing built ${route.authPlugin} OpenCode dist by absolute path; do not build or read operator config`);
    }
    return path;
}

/** The vault serves an access token, not a refresh token. Fail rather than refreshing locally. */
export function oauthSlot(access: string, now = Date.now()): Record<string, unknown> {
    let expires = now + 30 * 60_000;
    if (access.startsWith("sk-ant-oat")) {
        // The enrolled vault owns refresh. This short run uses the bearer it just served.
    } else {
        try {
            const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
            if (typeof payload.exp !== "number" || payload.exp * 1000 <= now + 60_000) throw new Error();
            expires = payload.exp * 1000;
        } catch {
            throw new Error("Vault did not serve a current OAuth access token; no local refresh will be attempted");
        }
    }
    // anthropic-auth requires a nonempty refresh slot even for an access-only fixture.
    // This non-credential placeholder cannot refresh an account; background refresh is off.
    return { type: "oauth", access, refresh: "mc-e2e-refresh-disabled", expires };
}

export function writeAuthConfig(root: string, route: ProviderRoute, material: string, recorderBaseURL: string): Record<string, string> {
    assertThrowawayRoot(root);
    if (!route.authPlugin) return {};
    const config = join(root, "config");
    const data = join(root, "data", "opencode");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "auth.json"), JSON.stringify({ [route.providerId]: oauthSlot(material) }), { mode: 0o600 });
    if (route.authPlugin === "anthropic-auth") {
        const path = join(config, "anthropic-auth.json");
        writeFileSync(path, JSON.stringify({
            version: 1, main: { type: "opencode", provider: "anthropic" }, accounts: [],
            routing: { mode: "main-first" }, refresh: { enabled: false }, quota: { enabled: false },
            cacheKeep: { enabled: false }, relay: { enabled: false }, dump: { enabled: false },
            thinkingBinding: { prefixMismatchBehavior: "error" },
        }), { mode: 0o600 });
        return {
            OPENCODE_ANTHROPIC_AUTH_FILE: path,
            OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(config, "anthropic-auth-state.json"),
            OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION: "1",
            ANTHROPIC_BASE_URL: recorderBaseURL,
        };
    }
    const path = join(config, "openai-auth.json");
    writeFileSync(path, JSON.stringify({ webSockets: false, rawWebSocket: false, dump: false,
        codexApiEndpoint: `${recorderBaseURL}/responses`, refresh: { enabled: false }, cacheKeep: { enabled: false } }), { mode: 0o600 });
    return {
        OPENCODE_OPENAI_AUTH_FILE: path,
        OPENCODE_OPENAI_AUTH_STATE_FILE: join(config, "openai-auth-state.json"),
        CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT: `${recorderBaseURL}/responses`,
        CORTEXKIT_OPENAI_AUTH_WEBSOCKETS: "false",
        CORTEXKIT_OPENAI_AUTH_RAW_WS: "false",
        CORTEXKIT_OPENAI_AUTH_DUMP: "false",
    };
}
