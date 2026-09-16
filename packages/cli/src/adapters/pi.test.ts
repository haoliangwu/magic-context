import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "./pi";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PiAdapter settings safety", () => {
    it("aborts plugin updates when existing settings are malformed", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-pi-adapter-"));
        tempDirs.push(root);
        process.env.PI_CODING_AGENT_DIR = root;
        const settingsPath = join(root, "settings.json");
        const malformed = `{"packages":[\n`;
        writeFileSync(settingsPath, malformed);

        const result = await new PiAdapter().ensurePluginEntry();

        expect(result.ok).toBe(false);
        expect(result.message).toContain("Refusing to overwrite unparseable config");
        expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
    });
});

describe("PiAdapter local checkout identity", () => {
    it("treats a local plugin checkout as registered and does not add the npm entry beside it", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-pi-adapter-local-"));
        tempDirs.push(root);
        process.env.PI_CODING_AGENT_DIR = root;
        // Pi stores `pi install <dir>` as a path relative to its agent directory.
        const checkout = join(root, "..", "mc-pi-checkout");
        mkdirSync(checkout, { recursive: true });
        tempDirs.push(checkout);
        writeFileSync(
            join(checkout, "package.json"),
            JSON.stringify({ name: "@cortexkit/pi-magic-context", version: "0.0.0" }),
        );
        const settingsPath = join(root, "settings.json");
        writeFileSync(settingsPath, JSON.stringify({ packages: ["../mc-pi-checkout"] }));

        const adapter = new PiAdapter();
        expect(adapter.hasPluginEntry()).toBe(true);
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([
            "../mc-pi-checkout",
        ]);
    });

    it("still registers the npm entry when the only local path is an unrelated extension", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-pi-adapter-unrelated-"));
        tempDirs.push(root);
        process.env.PI_CODING_AGENT_DIR = root;
        const other = join(root, "other-extension");
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "package.json"), JSON.stringify({ name: "pi-something-else" }));
        const settingsPath = join(root, "settings.json");
        writeFileSync(settingsPath, JSON.stringify({ packages: ["other-extension"] }));

        const adapter = new PiAdapter();
        expect(adapter.hasPluginEntry()).toBe(false);
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("added");
        expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toHaveLength(2);
    });
});
