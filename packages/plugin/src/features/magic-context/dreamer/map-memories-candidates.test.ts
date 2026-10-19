import { expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { type MapMemoryInput, seedIdentifierCandidates } from "./map-memories-prompt";

const memories: MapMemoryInput[] = [
    { id: 1, category: "ARCHITECTURE", content: "Named path", candidates: ["src/known.ts"] },
    { id: 2, category: "ARCHITECTURE", content: "FactAlpha handles the request.", candidates: [] },
];

async function withGitStub(source: string, run: (directory: string) => Promise<void>) {
    const directory = createTestTempDirFromPath(path.join(tmpdir(), "mc-map-async-git-"));
    const previousPath = process.env.PATH;
    writeFileSync(path.join(directory, "git"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
    try {
        await run(directory);
    } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        // A failed assertion must not leave the fixture's deliberately hung child alive.
        try {
            const pid = Number(readFileSync(path.join(directory, "git.pid"), "utf8"));
            if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
        } catch {
            // A completed lookup has already reaped its child.
        }
        rmSync(directory, { recursive: true, force: true });
    }
}

const recordPid = `import { writeFileSync } from "node:fs";
writeFileSync("git.pid", String(process.pid));`;

function expectGitReaped(directory: string) {
    const pid = Number(readFileSync(path.join(directory, "git.pid"), "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    let failure: unknown;
    try {
        process.kill(pid, 0);
    } catch (error) {
        failure = error;
    }
    expect(failure).toMatchObject({ code: "ESRCH" });
}

it.skipIf(process.platform === "win32")(
    "identifier prepass keeps the event loop responsive during git lookup",
    async () => {
        await withGitStub(
            `${recordPid}
setTimeout(() => { console.log("src/fact.ts:1:export const FactAlpha = 1;"); }, 500);`,
            async (directory) => {
                let ticks = 0;
                const timer = setInterval(() => {
                    ticks += 1;
                }, 10);
                const startedAt = performance.now();
                let seeded: MapMemoryInput[];
                try {
                    seeded = await seedIdentifierCandidates(memories, directory);
                } finally {
                    clearInterval(timer);
                }
                expect(performance.now() - startedAt).toBeGreaterThanOrEqual(450);
                expect(seeded[1]?.candidates).toEqual(["src/fact.ts"]);
                expect(ticks).toBeGreaterThanOrEqual(10);
                expectGitReaped(directory);
            },
        );
    },
);

it.skipIf(process.platform === "win32")(
    "identifier prepass kills timed-out git and preserves existing seeds",
    async () => {
        await withGitStub(
            `${recordPid}
process.on("SIGTERM", () => {});
console.log("src/fact.ts:1:FactAlpha");
setTimeout(() => process.exit(0), 5_000);`,
            async (directory) => {
                const startedAt = performance.now();
                expect(await seedIdentifierCandidates(memories, directory)).toBe(memories);
                expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_500);
                expect(performance.now() - startedAt).toBeLessThan(4_500);
                expectGitReaped(directory);
            },
        );
    },
    10_000,
);

it.skipIf(process.platform === "win32")(
    "identifier prepass discards partial stdout when git fails",
    async () => {
        await withGitStub(
            `${recordPid}
console.log("src/fact.ts:1:FactAlpha");
process.exit(2);`,
            async (directory) => {
                expect(await seedIdentifierCandidates(memories, directory)).toBe(memories);
                expectGitReaped(directory);
            },
        );
    },
);

it.skipIf(process.platform === "win32")(
    "identifier prepass kills git when its output exceeds the byte cap",
    async () => {
        await withGitStub(
            `${recordPid}
process.stdout.write("x".repeat(512 * 1024));
setTimeout(() => process.exit(0), 5_000);`,
            async (directory) => {
                const startedAt = performance.now();
                expect(await seedIdentifierCandidates(memories, directory)).toBe(memories);
                expect(performance.now() - startedAt).toBeLessThan(1_950);
                expectGitReaped(directory);
            },
        );
    },
    10_000,
);
