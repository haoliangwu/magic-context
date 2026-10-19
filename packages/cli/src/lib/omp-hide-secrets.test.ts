import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    checkOmpHideSecrets,
    collectHideSecretsSources,
    type HideSecretsSource,
    OMP_HIDE_SECRETS_DOCS_URL,
    readHideSecretsFromJson,
    readHideSecretsFromYaml,
} from "./omp-hide-secrets";

const roots: string[] = [];
const original = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CONFIG_FILES: process.env.PI_CONFIG_FILES,
    OMP_PROFILE: process.env.OMP_PROFILE,
    PI_PROFILE: process.env.PI_PROFILE,
};

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fixture root with a fake home, OMP agent dir and project; never the real ~/.omp. */
function fixture(): { home: string; agentDir: string; project: string } {
    const parent = join(tmpdir(), "magic-context", "omp-hide-secrets");
    mkdirSync(parent, { recursive: true });
    const root = createTestTempDirFromPath(join(parent, "lib-"));
    roots.push(root);
    const home = join(root, "home");
    const agentDir = join(home, ".omp", "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CONFIG_FILES;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_PROFILE;
    return { home, agentDir, project };
}

describe("readHideSecretsFromYaml", () => {
    it("reads the nested block form OMP writes", () => {
        expect(readHideSecretsFromYaml("secrets:\n  enabled: true\n")).toEqual({ kind: "on" });
        expect(readHideSecretsFromYaml("secrets:\n  enabled: false\n")).toEqual({ kind: "off" });
    });

    it("finds the key among siblings, comments and other top-level keys", () => {
        const text = [
            "# OMP settings",
            "compaction:",
            "  enabled: false",
            "secrets:",
            "  # Hide Secrets",
            "  other: 1",
            "",
            "  enabled: true # on",
            "memory:",
            "  backend: off",
        ].join("\n");
        expect(readHideSecretsFromYaml(text)).toEqual({ kind: "on" });
    });

    it("does not take another section's enabled key", () => {
        expect(readHideSecretsFromYaml("compaction:\n  enabled: true\n")).toEqual({
            kind: "absent",
        });
        expect(readHideSecretsFromYaml("secrets:\n  other:\n    enabled: true\n")).toEqual({
            kind: "absent",
        });
    });

    it("reads a one-line flow mapping", () => {
        expect(readHideSecretsFromYaml("secrets: { enabled: true }\n")).toEqual({ kind: "on" });
        expect(readHideSecretsFromYaml("secrets: {other: 1, enabled: false}\n")).toEqual({
            kind: "off",
        });
    });

    it("treats a missing, empty or null value as not set", () => {
        expect(readHideSecretsFromYaml("")).toEqual({ kind: "absent" });
        expect(readHideSecretsFromYaml("secrets:\n")).toEqual({ kind: "absent" });
        expect(readHideSecretsFromYaml("secrets: null\n")).toEqual({ kind: "absent" });
        expect(readHideSecretsFromYaml("secrets:\n  enabled: ~\n")).toEqual({ kind: "absent" });
    });

    it("reports shapes it cannot be sure about instead of guessing", () => {
        for (const text of [
            'secrets:\n  enabled: "true"\n',
            "secrets:\n  enabled: yes\n",
            "secrets:\n  enabled: *anchor\n",
            "secrets:\n  enabled: true\nsecrets:\n  enabled: false\n",
            "secrets:\n  enabled: true\n  enabled: false\n",
            "secrets: {\n  enabled: true }\n",
            "{secrets: {enabled: true}}\n",
            "secrets:\n\tenabled: true\n",
        ]) {
            expect(readHideSecretsFromYaml(text).kind).toBe("unreadable");
        }
    });
});

describe("readHideSecretsFromJson", () => {
    it("reads on, off and not set", () => {
        expect(readHideSecretsFromJson('{"secrets":{"enabled":true}}')).toEqual({ kind: "on" });
        expect(readHideSecretsFromJson('{"secrets":{"enabled":false}}')).toEqual({ kind: "off" });
        expect(readHideSecretsFromJson('{"theme":"dark"}')).toEqual({ kind: "absent" });
    });

    it("reports invalid JSON as unreadable", () => {
        expect(readHideSecretsFromJson("{ // comment\n}").kind).toBe("unreadable");
    });
});

describe("collectHideSecretsSources", () => {
    it("reads user, project and overlay files in OMP precedence order", () => {
        const { agentDir, project } = fixture();
        writeFileSync(join(agentDir, "config.yml"), "secrets:\n  enabled: true\n");
        mkdirSync(join(project, ".omp"));
        writeFileSync(join(project, ".omp", "settings.json"), '{"secrets":{"enabled":true}}');
        writeFileSync(join(project, ".omp", "config.yml"), "secrets:\n  enabled: false\n");
        const overlay = join(project, "overlay.yml");
        writeFileSync(overlay, "secrets:\n  enabled: true\n");
        process.env.PI_CONFIG_FILES = ["overlay.yml", "missing.yml"].join(delimiter);

        const sources = collectHideSecretsSources(project);

        expect(sources.map(({ layer, path, value }) => [layer, path, value.kind])).toEqual([
            ["user", join(agentDir, "config.yml"), "on"],
            ["project", join(project, ".omp", "settings.json"), "on"],
            ["project", join(project, ".omp", "config.yml"), "off"],
            ["overlay", overlay, "on"],
        ]);
    });

    it("falls back to config.yaml and skips the project layer at home", () => {
        const { home, agentDir } = fixture();
        writeFileSync(join(agentDir, "config.yaml"), "secrets:\n  enabled: true\n");
        // At home, `~/.omp` is OMP's config root, not a project dir, so its files are skipped.
        writeFileSync(join(home, ".omp", "config.yml"), "secrets:\n  enabled: true\n");

        const sources = collectHideSecretsSources(home);

        expect(sources.map(({ layer, path }) => [layer, path])).toEqual([
            ["user", join(agentDir, "config.yaml")],
        ]);
    });

    it("reports a file that exists but cannot be read", () => {
        const { agentDir, project } = fixture();
        // A directory in place of the file fails to read for every user, root included.
        mkdirSync(join(agentDir, "config.yml"));

        const [source] = collectHideSecretsSources(project);

        expect(source?.value.kind).toBe("unreadable");
        expect(source?.value).toMatchObject({ reason: expect.stringContaining("EISDIR") });
    });
});

describe("checkOmpHideSecrets", () => {
    const user = (kind: "on" | "off" | "absent"): HideSecretsSource => ({
        layer: "user",
        path: "/fixture/agent/config.yml",
        value: { kind },
    });
    const unreadable: HideSecretsSource = {
        layer: "project",
        path: "/fixture/project/.omp/config.yml",
        value: { kind: "unreadable", reason: "file could not be read (EACCES)" },
    };

    it("warns with the docs link when the setting is on", () => {
        const [check, ...rest] = checkOmpHideSecrets([user("on")]);

        expect(rest).toHaveLength(0);
        expect(check?.status).toBe("warn");
        expect(check?.message).toContain("OMP Hide Secrets (secrets.enabled) is on");
        expect(check?.message).toContain("/fixture/agent/config.yml");
        expect(check?.message).toContain(OMP_HIDE_SECRETS_DOCS_URL);
        expect(check?.message).toContain("CLI flags and live settings toggles can't be detected");
        expect(check?.issueMessage).toContain("is on in OMP user settings:");
        expect(check?.issueMessage).not.toContain("/fixture");
    });

    it("lets a higher layer turn it off", () => {
        const project: HideSecretsSource = { ...user("off"), layer: "project" };
        expect(checkOmpHideSecrets([user("on"), project])).toEqual([
            expect.objectContaining({ status: "pass", message: expect.stringContaining("is off") }),
        ]);
    });

    it("passes when the setting is off or not set", () => {
        expect(checkOmpHideSecrets([user("off")])[0]).toMatchObject({
            status: "pass",
            message: expect.stringContaining("is off in OMP settings files"),
        });
        for (const sources of [[], [user("absent")]]) {
            expect(checkOmpHideSecrets(sources)[0]).toMatchObject({
                status: "pass",
                message: expect.stringContaining("is not set in OMP settings files"),
            });
        }
    });

    it("warns when a file that could decide the value is unreadable", () => {
        const [check, ...rest] = checkOmpHideSecrets([user("off"), unreadable]);

        expect(rest).toHaveLength(0);
        expect(check?.status).toBe("warn");
        expect(check?.message).toContain("Could not check OMP Hide Secrets");
        expect(check?.message).toContain("/fixture/project/.omp/config.yml");
        expect(check?.message).toContain(OMP_HIDE_SECRETS_DOCS_URL);
        expect(check?.issueMessage).not.toContain("/fixture");
    });

    it("ignores an unreadable file below the layer that decides the value", () => {
        const lower: HideSecretsSource = { ...unreadable, layer: "user" };
        const higher: HideSecretsSource = { ...user("off"), layer: "project" };
        expect(checkOmpHideSecrets([lower, higher])[0]?.status).toBe("pass");
    });
});
