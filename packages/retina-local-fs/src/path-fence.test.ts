import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { resolveAndFenceProviderPath } from "./path-fence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
});

async function fixture() {
    const base = await createTestTempDirFromPath(join(tmpdir(), "retina-path-fence-"));
    temporaryDirectories.push(base);
    const homeDirectory = join(base, "home");
    const dataDirectory = join(homeDirectory, ".local", "share");
    const cortexkit = join(dataDirectory, "cortexkit");
    const backing = join(base, "backing");
    await mkdir(dataDirectory, { recursive: true });
    await mkdir(backing);
    await mkdir(cortexkit);
    return {
        base,
        homeDirectory,
        cortexkit,
        backing,
        options: { homeDirectory, dataDirectory, allowMissing: true },
    };
}

describe("path fence containment and canonicalization", () => {
    test("admits a ..foo child through the module bin carve-in", async () => {
        const { cortexkit, options } = await fixture();
        const child = join(cortexkit, "..foo", "bin", "binding-key");
        await mkdir(dirname(child), { recursive: true });
        await writeFile(child, "public executable");

        // CortexKit module bin directories are public, even for names normally treated as secrets.
        const canonical = await realpath(child);
        expect(await resolveAndFenceProviderPath(child, options)).toBe(canonical);
    });

    test("refuses a parent-prefix sibling instead of inheriting the module bin carve-in", async () => {
        const { cortexkit, options } = await fixture();
        const sibling = join(`${cortexkit}-backup`, "plexus", "bin", "binding-key");
        await mkdir(dirname(sibling), { recursive: true });
        await writeFile(sibling, "private key");

        await expect(resolveAndFenceProviderPath(sibling, options)).rejects.toMatchObject({
            code: "fenced_path",
        });
    });

    test("refuses a missing leaf whose symlinked ancestor resolves into a fenced root", async () => {
        const { homeDirectory, cortexkit, options } = await fixture();
        await mkdir(join(cortexkit, "plexus"));
        const escapeLink = join(homeDirectory, "escape");
        await symlink(join(cortexkit, "plexus"), escapeLink);
        const missing = join(escapeLink, "missing", "leaf");

        await expect(resolveAndFenceProviderPath(missing, options)).rejects.toMatchObject({
            code: "fenced_path",
        });
    });

    test("fences a ..foo descendant of a symlinked private root", async () => {
        const { cortexkit, backing, options } = await fixture();
        await symlink(backing, join(cortexkit, "plexus"));
        const child = join(backing, "..foo");
        await writeFile(child, "private data");

        await expect(resolveAndFenceProviderPath(child, options)).rejects.toMatchObject({
            code: "fenced_path",
        });
    });

    test("resolves an ordinary missing leaf through existing canonical ancestors", async () => {
        const { base, homeDirectory, options } = await fixture();
        const ordinary = join(base, "ordinary");
        await mkdir(ordinary);
        const alias = join(homeDirectory, "ordinary-alias");
        await symlink(ordinary, alias);
        const suffix = ["missing", "leaf"];

        expect(await resolveAndFenceProviderPath(join(alias, ...suffix), options)).toBe(
            join(await realpath(ordinary), ...suffix),
        );
    });

    test("refuses a dangling symlink even when missing paths are allowed", async () => {
        const { base, homeDirectory, options } = await fixture();
        const dangling = join(homeDirectory, "dangling");
        await symlink(join(base, "absent"), dangling);

        await expect(resolveAndFenceProviderPath(dangling, options)).rejects.toMatchObject({
            code: "unreadable_path",
        });
    });

    test("refuses a missing leaf under a dangling symlink", async () => {
        const { base, homeDirectory, options } = await fixture();
        const dangling = join(homeDirectory, "dangling");
        await symlink(join(base, "absent"), dangling);

        await expect(
            resolveAndFenceProviderPath(join(dangling, "missing", "leaf"), options),
        ).rejects.toMatchObject({ code: "unreadable_path" });
    });
});
