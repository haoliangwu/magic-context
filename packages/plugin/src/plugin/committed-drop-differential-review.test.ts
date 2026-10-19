import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTestTempDirFromPath } from "../shared/test-temp-dir";

// Export exact baseline file contents with git show into REVIEW_BASELINE before
// running this comparator. It overlays source files and restores their saved
// bytes in finally without Git writes, so it also works on build servers that
// expose the repository's Git metadata read-only.
test.skipIf(!process.env.REVIEW_BASELINE)(
    "independent healthy differential: 432 complete served arrays and durable snapshots",
    () => {
        const baseline = JSON.parse(readFileSync(process.env.REVIEW_BASELINE!, "utf8")) as Record<
            string,
            string | null
        >;
        const checkout = resolve(import.meta.dir, "../../../..");
        const original = new Map(
            Object.keys(baseline).map((path) => [
                path,
                existsSync(join(checkout, path))
                    ? readFileSync(join(checkout, path), "utf8")
                    : null,
            ]),
        );
        const parent = join(tmpdir(), "magic-context");
        mkdirSync(parent, { recursive: true });
        const root = createTestTempDirFromPath(join(parent, "healthy-differential-"));
        const seeds = [719, 880301, 192837];
        const observed = new Map<string, string>();
        let comparisons = 0;
        const overlay = (sources: Iterable<readonly [string, string | null]>) => {
            for (const [path, content] of sources) {
                if (content === null) rmSync(join(checkout, path), { force: true });
                else writeFileSync(join(checkout, path), content);
            }
        };
        try {
            for (const variant of ["base", "current"]) {
                overlay(variant === "base" ? Object.entries(baseline) : original);
                for (const lane of ["oc1", "oc2", "pi"])
                    for (const seed of seeds) {
                        const dir = join(root, `${variant}-${lane}-${seed}`);
                        mkdirSync(dir);
                        const result = spawnSync(
                            process.execPath,
                            [
                                join(import.meta.dir, "__tests__/committed-drop-review.fixture.ts"),
                                dir,
                                lane,
                                "healthy",
                                "2",
                                String(seed),
                            ],
                            {
                                env: {
                                    ...process.env,
                                    OPENCODE_DB: undefined,
                                    MAGIC_CONTEXT_STORAGE_DIR: join(dir, "store"),
                                    MAGIC_CONTEXT_TEST_DATA_DIR: dir,
                                    XDG_CONFIG_HOME: dir,
                                    XDG_DATA_HOME: dir,
                                    BUN_JSC_useOMGJIT: "0",
                                },
                                windowsHide: true,
                                encoding: "utf8",
                                timeout: 90000,
                                maxBuffer: 8 * 1024 * 1024,
                            },
                        );
                        expect(result.status, result.stderr).toBe(0);
                        const line = result.stdout
                            .split("\n")
                            .find((line) => line.startsWith("REVIEW_RESULT "));
                        if (!line) throw new Error(result.stdout + result.stderr);
                        const proof = JSON.parse(line.slice(14));
                        expect(proof.passes).toBe(48);
                        if (lane !== "pi") expect(proof.recoveryCount).toBe(0);
                        expect(proof.drops).toBeGreaterThan(0);
                        const records = JSON.parse(
                            readFileSync(join(dir, "records.json"), "utf8"),
                        ) as unknown[];
                        const key = `${lane}-${seed}`;
                        if (variant === "base") observed.set(key, JSON.stringify(records));
                        else {
                            const before = JSON.parse(observed.get(key)!) as unknown[];
                            for (let pass = 0; pass < 48; pass++) {
                                expect(records[pass], `${key} pass ${pass}`).toEqual(before[pass]);
                                comparisons++;
                            }
                        }
                        console.log(
                            `HEALTHY_DIFFERENTIAL ${variant} ${key} passes=48 drops=${proof.drops} recovery=${proof.recoveryCount ?? "not-instrumented"}`,
                        );
                    }
            }
            expect(comparisons).toBe(432);
        } finally {
            overlay(original);
            rmSync(root, { recursive: true, force: true });
        }
    },
    900000,
);
