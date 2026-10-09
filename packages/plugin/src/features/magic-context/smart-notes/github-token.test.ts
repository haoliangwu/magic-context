import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getMagicContextStorageDir } from "../../../shared/data-path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { localSmartNoteHttpTransport } from "./__tests__/http-timeout-fixture.test";
import { createSmartNoteCapabilities, readSmartNoteGithubToken } from "./capabilities";
import { guardedSmartNoteHttpGet } from "./ssrf-guard";

const TOKEN = "test-github-token-value";
const signal = new AbortController().signal;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function withStorageRoot<T>(run: (storageDir: string) => Promise<T>): Promise<T> {
    const root = await createTestTempDirFromPath(path.join(tmpdir(), "mc-smart-note-gh-token-"));
    const previous = {
        testDataDir: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
        xdgDataHome: process.env.XDG_DATA_HOME,
    };
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
    process.env.XDG_DATA_HOME = root;
    const storageDir = getMagicContextStorageDir();
    try {
        await mkdir(storageDir, { recursive: true, mode: 0o700 });
        return await run(storageDir);
    } finally {
        if (previous.testDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previous.testDataDir;
        if (previous.xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous.xdgDataHome;
        await rm(root, { recursive: true, force: true });
    }
}

async function writeToken(storageDir: string, mode = 0o600): Promise<void> {
    const filePath = path.join(storageDir, "github-token");
    await writeFile(filePath, `  ${TOKEN}\n`, { mode });
    await chmod(filePath, mode);
}

describe("smart-note GitHub token capability", () => {
    test("sends a trimmed owner-only token to api.github.com and redacts it from guest values", async () => {
        await withStorageRoot(async (storageDir) => {
            await writeToken(storageDir);
            const token = await readSmartNoteGithubToken();
            expect(token).toBe(TOKEN);

            const observed: Array<string | undefined> = [];
            const transport = await localSmartNoteHttpTransport(
                "api.github.com",
                (request, response) => {
                    observed.push(request.headers.authorization);
                    response.end(JSON.stringify({ authorization: request.headers.authorization }));
                },
            );
            cleanups.push(transport.dispose);
            const capabilities = createSmartNoteCapabilities({
                projectRoot: tmpdir(),
                signal,
                githubToken: token,
            });

            const result = await capabilities.httpGet("https://api.github.com/echo");
            expect(observed).toEqual([`Bearer ${TOKEN}`]);
            expect(result.body).toContain("Bearer [redacted]");
            expect(result.body).not.toContain(TOKEN);
        });
    });

    test("does not add authorization when the token file is absent", async () => {
        await withStorageRoot(async () => {
            expect(await readSmartNoteGithubToken()).toBeNull();
            const observed: Array<string | undefined> = [];
            const transport = await localSmartNoteHttpTransport(
                "api.github.com",
                (request, response) => {
                    observed.push(request.headers.authorization);
                    response.end("public");
                },
            );
            cleanups.push(transport.dispose);
            const capabilities = createSmartNoteCapabilities({
                projectRoot: tmpdir(),
                signal,
                githubToken: null,
            });

            await capabilities.httpGet("https://api.github.com/resource");
            expect(observed).toEqual([undefined]);
        });
    });

    test("omits authorization for other hosts and redirects away from GitHub", async () => {
        await withStorageRoot(async (storageDir) => {
            await writeToken(storageDir);
            const token = await readSmartNoteGithubToken();
            const observed: Array<{ host: string; authorization: string | undefined }> = [];
            const transport = await localSmartNoteHttpTransport(
                ["api.github.com", "redirect.test"],
                (request, response) => {
                    const host = String(request.headers.host);
                    observed.push({ host, authorization: request.headers.authorization });
                    if (host === "api.github.com") {
                        response.writeHead(302, { Location: "https://redirect.test/target" });
                        response.end();
                    } else {
                        response.end("redirected");
                    }
                },
            );
            cleanups.push(transport.dispose);
            const capabilities = createSmartNoteCapabilities({
                projectRoot: tmpdir(),
                signal,
                githubToken: token,
            });

            await capabilities.httpGet("https://api.github.com:444/resource");
            await capabilities.httpGet("https://redirect.test/resource");
            await capabilities.httpGet("https://api.github.com/redirect");
            expect(observed).toEqual([
                { host: "api.github.com:444", authorization: undefined },
                { host: "redirect.test", authorization: undefined },
                { host: "api.github.com", authorization: `Bearer ${TOKEN}` },
                { host: "redirect.test", authorization: undefined },
            ]);
        });
    });

    test("refuses a group-readable token and logs one warning without its contents", async () => {
        await withStorageRoot(async (storageDir) => {
            await writeToken(storageDir, 0o644);
            const warnings: string[] = [];

            expect(
                await readSmartNoteGithubToken({ warn: (message) => warnings.push(message) }),
            ).toBeNull();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("0600");
            expect(warnings.join("\n")).not.toContain(TOKEN);
        });
    });

    test("does not expose the token in HTTP errors", async () => {
        await withStorageRoot(async (storageDir) => {
            await writeToken(storageDir);
            const token = await readSmartNoteGithubToken();
            const error = await guardedSmartNoteHttpGet("https://api.github.com/resource", {
                signal,
                githubToken: token,
                resolver: { lookup: async () => [{ address: "1.1.1.1", family: 4 }] },
                requestAddress: async () => {
                    throw new Error(`transport failed with ${TOKEN}`);
                },
            }).catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toContain(TOKEN);
            expect((error as Error).message).toContain("[redacted]");
        });
    });
});
