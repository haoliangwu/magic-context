import { expect, spyOn, test } from "bun:test";
import { existsSync, promises as fs, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import * as cache from "./project-identity-cache";

test("maintenance prunes only identity records whose directory is definitely ENOENT", async () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "identity-prune-"));
    const prior = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    const projects = ["gone", "live", "denied", "io-error", "not-directory"].map((name) =>
        join(root, name),
    );
    const stat = fs.stat.bind(fs);
    let probe: ReturnType<typeof spyOn> | undefined;
    try {
        for (const directory of projects) {
            mkdirSync(directory);
            cache.rememberGitIdentity(directory, "git:abcdef1234");
        }
        rmSync(projects[0]!, { recursive: true });
        const records = await fs.readdir(join(getMagicContextStorageDir(), "project-identities"));
        const goneRecord = records
            .map((name) => join(getMagicContextStorageDir(), "project-identities", name))
            .find((file) => JSON.parse(readFileSync(file, "utf8")).directory === projects[0]);
        probe = spyOn(fs, "stat").mockImplementation(((directory: string) => {
            const code =
                directory === projects[2]
                    ? "EACCES"
                    : directory === projects[3]
                      ? "EIO"
                      : directory === projects[4]
                        ? "ENOTDIR"
                        : undefined;
            if (code) return Promise.reject(Object.assign(new Error(code), { code }));
            return stat(directory);
        }) as typeof fs.stat);
        const removed =
            (await (cache as Partial<typeof cache>).pruneMissingProjectIdentities?.()) ?? 0;
        expect(removed).toBe(1);
        expect(existsSync(goneRecord!)).toBe(false);
        for (const directory of projects.slice(1))
            expect(cache.readRememberedGitIdentity(directory)).toBe("git:abcdef1234");
    } finally {
        probe?.mockRestore();
        if (prior === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prior;
        rmSync(root, { recursive: true, force: true });
    }
});
