import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpenCodeV1FixtureStore } from "../../../hooks/magic-context/opencode-v1-store-fixture";
import { closeReadOnlySessionDb } from "../../../hooks/magic-context/read-session-db";
import { _resetHarnessForTesting } from "../../../shared/harness";
import { resetOpenCodeDbPathStateForTesting } from "../../../shared/opencode-db-path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    assertBoundedHeap,
    measurePrimerRefresh,
} from "./__tests__/primer-refresh-heap-fixture.test";

const original = process.env.OPENCODE_DB;
const dirs: string[] = [];
afterEach(() => {
    closeReadOnlySessionDb();
    _resetHarnessForTesting();
    if (original === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = original;
    resetOpenCodeDbPathStateForTesting();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("OpenCode primer refresh peak heap does not grow with same-project history", async () => {
    const measurements = [];
    for (const turns of [500, 5_000]) {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-primer-refresh-"));
        dirs.push(dir);
        const path = join(dir, "opencode.db");
        writeOpenCodeV1FixtureStore(path, [
            {
                sessionId: "ses_primer",
                directory: "/fixture/primer",
                turns,
                toolOutputChars: 16_384,
                diagnosticsPerTool: 40,
            },
        ]);
        closeReadOnlySessionDb();
        process.env.OPENCODE_DB = path;
        resetOpenCodeDbPathStateForTesting();
        _resetHarnessForTesting();
        measurements.push(await measurePrimerRefresh("ses_primer", turns * 2));
    }
    expect(measurements).toHaveLength(2);
    assertBoundedHeap(measurements[0], measurements[1]);
}, 60_000);
