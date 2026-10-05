import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { assertThrowawayRoot, authPluginPath, oauthSlot, writeAuthConfig } from "./auth";
import { databaseFilesFromLsof, startHost } from "./host";
import { startRecorder } from "./recorder";
import { ALL_SCENARIOS } from "./scenarios";
import { claudeOAuth } from "./scenarios/anthropic";
import { codex } from "./scenarios/codex";
import type { AuthPlugin } from "./types";

const tempBase = join(tmpdir(), "magic-context", "live-provider-tests");
mkdirSync(tempBase, { recursive: true });
const jwt = (exp: number) => `fixture.${Buffer.from(JSON.stringify({ exp,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" }, email: "fixture@example.invalid" })).toString("base64url")}.fixture`;

describe("disposable subscription auth", () => {
    it("drops Bedrock and registers one explicit Claude and Codex account", () => {
        expect(ALL_SCENARIOS.some((s) => s.route.providerId === "amazon-bedrock")).toBe(false);
        expect(claudeOAuth.credentialId).toBe("oauth:anthropic");
        expect(codex.credentialId).toBe("chatgpt:openai");
    });

    it("requires an existing absolute dist path, without reading operator config", () => {
        expect(() => authPluginPath(claudeOAuth)).toThrow("existing built anthropic-auth");
        expect(() => authPluginPath(codex, { "openai-auth": "relative.js" })).toThrow();
        expect(authPluginPath({ ...claudeOAuth, authPlugin: undefined })).toBeNull();
    });

    it("rejects expired or non-access OAuth material", () => {
        expect(() => oauthSlot("sk-ant-ort-fixture", 1000)).toThrow();
        expect(() => oauthSlot(jwt(1), 1000)).toThrow();
        expect(oauthSlot(jwt(10000), 1000)).toMatchObject({ refresh: "mc-e2e-refresh-disabled", expires: 10000000 });
    });

    it("writes only a disposable login slot and points both plugins at disposable files", () => {
        const root = createTestTempDirFromPath(join(tempBase, "auth-"));
        mkdirSync(join(root, "config"));
        try {
            const env = writeAuthConfig(root, claudeOAuth, "sk-ant-oat-fixture", "http://127.0.0.1:1234/v1");
            const slot = join(root, "data", "opencode", "auth.json");
            expect(JSON.parse(readFileSync(slot, "utf8"))).toMatchObject({ anthropic: { access: "sk-ant-oat-fixture", refresh: "mc-e2e-refresh-disabled" } });
            expect(statSync(slot).mode & 0o777).toBe(0o600);
            expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1234/v1");
            expect(env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE).toBe(join(root, "config", "anthropic-auth-state.json"));
            const codexEnv = writeAuthConfig(root, codex, jwt(Math.floor(Date.now() / 1000) + 3600), "http://127.0.0.1:1234/backend-api/codex");
            expect(codexEnv.CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT).toBe("http://127.0.0.1:1234/backend-api/codex/responses");
            expect(codexEnv.CORTEXKIT_OPENAI_AUTH_WEBSOCKETS).toBe("false");
            expect(codexEnv.OPENCODE_OPENAI_AUTH_FILE).toBe(join(root, "config", "openai-auth.json"));
        } finally { rmSync(root, { recursive: true, force: true }); }
        expect(existsSync(root)).toBe(false);
    });

    it("rejects fake temp-root lookalikes", () => {
        expect(() => assertThrowawayRoot(join(tmpdir(), "not-magic-context", "magic-context", "fake"))).toThrow();
    });

    it("lsof isolation rejects missing, external and prefix-lookalike database handles", () => {
        const root = createTestTempDirFromPath(join(tempBase, "lsof-"));
        const row = (path: string) => `opencode 123 user 4u REG 1,1 0 1 ${path}`;
        try {
            const inside = row(join(realpathSync(root), "data", "live.db"));
            expect(databaseFilesFromLsof(inside, root)).toEqual(["<root>/data/live.db"]);
            expect(() => databaseFilesFromLsof("", root)).toThrow("Database isolation failed");
            expect(() => databaseFilesFromLsof(`${inside}\n${row("/synthetic-operator/opencode/live.db")}`, root)).toThrow();
            expect(() => databaseFilesFromLsof(row(`${root}-other/data/live.db`), root)).toThrow();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

// Explicitly opt in to installed-plugin wire probes. These use only fake bearer fixtures
// and a loopback upstream; they do not enroll, read the vault, or call a model service.
it.skipIf(process.env.MC_LIVE_AUTH_SMOKE !== "1")("installed auth dists shape both subscription routes in isolated hosts", async () => {
    const plugins: Partial<Record<AuthPlugin, string>> = {
        "anthropic-auth": process.env.MC_LIVE_ANTHROPIC_AUTH_PLUGIN,
        "openai-auth": process.env.MC_LIVE_OPENAI_AUTH_PLUGIN,
    };
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: "fixture rejection" } }, { status: 400 }) });
    try {
        for (const base of [claudeOAuth, codex]) {
            const route = { ...base, upstreamBase: `http://127.0.0.1:${upstream.port}/v1` };
            const root = join(tempBase, `host-${base.id}-${crypto.randomUUID()}`);
            const token = base === claudeOAuth ? "sk-ant-oat-fixture" : jwt(Math.floor(Date.now() / 1000) + 3600);
            const recorder = startRecorder(route, 1, () => [token]);
            const host = await startHost({ binary: process.env.MC_LIVE_OPENCODE!, root, route, apiKey: token,
                recorderBaseURL: recorder.baseURL, magicContext: {}, authPlugins: plugins });
            try {
                const session = (await host.api("/session", { title: "fixture" })).value as { id: string };
                expect(host.checkIsolation().every((p) => p.startsWith("<root>/"))).toBe(true);
                await host.api(`/session/${session.id}/message`, { model: { providerID: route.providerId, modelID: route.model },
                    parts: [{ type: "text", text: "Reply OK. Do not use tools." }] }, 60_000);
                await recorder.settled();
                expect(recorder.calls.length).toBe(1);
                expect(recorder.calls[0]?.status).toBe(400);
                expect(recorder.calls[0]?.model).toBe(route.model);
                if (base === claudeOAuth) expect(recorder.calls[0]?.request.flags.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
                else expect(recorder.calls[0]?.request.flags.store).toBe(false);
                host.checkIsolation();
            } finally { await host.dispose(); recorder.stop(); }
            expect(existsSync(root)).toBe(false);
        }
    } finally { upstream.stop(true); }
}, 120_000);
