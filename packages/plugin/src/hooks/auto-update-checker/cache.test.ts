import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

const tempDirs: string[] = [];
const PACKAGE_NAME = "@cortexkit/opencode-magic-context";

function fixture(version = "0.15.5") {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-auto-update-cache-"));
    tempDirs.push(root);
    const installDir = join(root, "install");
    const packageDir = join(installDir, "node_modules", "@cortexkit", "opencode-magic-context");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ dependencies: { [PACKAGE_NAME]: version } }),
    );
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version }),
    );
    return {
        installDir,
        packagePath: join(packageDir, "package.json"),
    };
}

afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("auto-update-checker/cache", () => {
    test("resolves the active install root without mutating it", async () => {
        const fixtureData = fixture();
        const before = readFileSync(join(fixtureData.installDir, "package.json"), "utf-8");
        const { resolveInstallContext } = await import(`./cache.ts?cache=${Date.now()}`);
        expect(resolveInstallContext(fixtureData.packagePath)).toEqual({
            installDir: fixtureData.installDir,
            packageJsonPath: join(fixtureData.installDir, "package.json"),
        });
        expect(readFileSync(join(fixtureData.installDir, "package.json"), "utf-8")).toBe(before);
    });
});
