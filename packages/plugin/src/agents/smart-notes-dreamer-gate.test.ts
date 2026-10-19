import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed, parsePluginConfig } from "../config";
import { isDreamerRunnable, isSmartNoteSurfaceAvailable } from "../config/agent-disable";
import { pluginConfigReader } from "../config/live-run-config";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import type { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    GATE_CASE_COUNT,
    gateCases,
    renderToolSurfaces,
    type ToolSurfaceDigests,
} from "./smart-notes-dreamer-gate.fixture";
import golden from "./smart-notes-dreamer-gate.golden.json";

// Smart notes are evaluated by the dreamer, so ctx_note drops its smart-note
// argument and text when the dreamer is not runnable, as it already did for
// smart_notes.enabled=false. The golden holds the tool bytes from before that
// gate; every config with a runnable dreamer must still render them exactly.

const SMART_NOTE_TEXT = /surface_condition|smart.note|outside checker/i;
const oldXdg = process.env.XDG_DATA_HOME;
let dir: string;
let db: Database;

beforeAll(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "smart-notes-dreamer-gate-"));
    process.env.XDG_DATA_HOME = dir;
    db = openDatabase();
});
afterAll(() => {
    closeDatabase();
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldXdg;
    rmSync(dir, { recursive: true, force: true });
});

const render = (raw: Record<string, unknown>): Promise<ToolSurfaceDigests> => {
    const config = parsePluginConfig(raw);
    // The value context.ts passes to the OpenCode 2 per-request rewrite.
    return renderToolSurfaces({
        config,
        directory: dir,
        db,
        oc2SmartNotes: isSmartNoteSurfaceAvailable(config),
    });
};

test("ctx_* tool bytes match the pre-gate golden for every config with a runnable dreamer, and only ctx_note changes when the dreamer is off", async () => {
    const cases = gateCases();
    const expected = (golden as { cases: Array<Omit<ToolSurfaceDigests, "text">> }).cases;
    expect(cases).toHaveLength(GATE_CASE_COUNT);
    expect(expected).toHaveLength(GATE_CASE_COUNT);

    let runnable = 0;
    let gatedChanged = 0;
    let gatedAlreadyOff = 0;
    for (const [index, raw] of cases.entries()) {
        const config = parsePluginConfig(raw);
        const got = await render(raw);
        const before = expected[index];
        if (!before) throw new Error(`golden has no case ${index}`);
        const label = `case ${index} ${JSON.stringify(raw)}`;
        if (isDreamerRunnable(config)) {
            runnable++;
            expect({ label, oc1: got.oc1, oc2: got.oc2 }).toEqual({
                label,
                oc1: before.oc1,
                oc2: before.oc2,
            });
            continue;
        }
        // Dreamer off: every other tool is untouched...
        expect({ label, oc1: got.oc1.other, oc2: got.oc2.other }).toEqual({
            label,
            oc1: before.oc1.other,
            oc2: before.oc2.other,
        });
        // ...and ctx_note is exactly the smart-notes-off surface of the same config.
        const off = await render({ ...raw, smart_notes: { enabled: false } });
        expect({ label, oc1: got.oc1.note, oc2: got.oc2.note }).toEqual({
            label,
            oc1: off.oc1.note,
            oc2: off.oc2.note,
        });
        const ctxNote = (text: string) =>
            JSON.stringify((JSON.parse(text) as Record<string, unknown>).ctx_note);
        expect(ctxNote(got.text.oc1)).not.toMatch(SMART_NOTE_TEXT);
        expect(ctxNote(got.text.oc2)).not.toMatch(SMART_NOTE_TEXT);
        if (config.smart_notes.enabled === false) {
            gatedAlreadyOff++;
            expect(got.oc1.note).toBe(before.oc1.note);
            expect(got.oc2.note).toBe(before.oc2.note);
        } else {
            gatedChanged++;
            expect(got.oc1.note).not.toBe(before.oc1.note);
            expect(got.oc2.note).not.toBe(before.oc2.note);
        }
    }
    // Keep the differential meaningful: both sides must be well populated.
    expect(runnable).toBeGreaterThanOrEqual(100);
    expect(gatedChanged).toBeGreaterThanOrEqual(40);
    expect(gatedAlreadyOff).toBeGreaterThanOrEqual(20);
});

test("the OpenCode 2 per-request rewrite receives the dreamer-aware smart-note flag", () => {
    // The differential above passes this flag itself, so pin the production call.
    const source = readFileSync(join(import.meta.dir, "../v2/hooks/context.ts"), "utf8");
    expect(source).toMatch(
        /applyV2PromptSurfaceTools\(\s*draft,\s*promptSurfaceRuntime,\s*config\.prompt_surface,[^)]*isSmartNoteSurfaceAvailable\(config\),\s*\)/,
    );
});

test("a live dreamer toggle never changes the tool bytes registered for this process", async () => {
    const previousHome = process.env.HOME;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    try {
        for (const [bootDreamer, liveDreamer] of [
            [{}, { disable: true }],
            [{ disable: true }, { disable: false }],
        ] as const) {
            const root = createTestTempDirFromPath(join(dir, "live-"));
            process.env.HOME = root;
            process.env.XDG_CONFIG_HOME = join(root, "config");
            const directory = join(root, "project");
            const configPath = join(root, "config", "cortexkit", "magic-context.jsonc");
            mkdirSync(directory, { recursive: true });
            mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ dreamer: bootDreamer }));
            const boot = loadPluginConfigDetailed(directory, false).config;
            const bootAvailable = isSmartNoteSurfaceAvailable(boot);
            // Registration reads the boot config once, as the hosts do.
            const registered = () =>
                renderToolSurfaces({
                    config: boot,
                    directory,
                    db,
                    oc2SmartNotes: isSmartNoteSurfaceAvailable(boot),
                });
            const before = await registered();

            const reader = pluginConfigReader(directory, boot);
            writeFileSync(configPath, JSON.stringify({ dreamer: liveDreamer }));
            const effective = reader.poll().effective;
            // The live view did flip, so the comparison below is not vacuous...
            expect(isSmartNoteSurfaceAvailable(effective)).toBe(!bootAvailable);
            // ...while the boot config the tools were built from is untouched.
            expect(isSmartNoteSurfaceAvailable(boot)).toBe(bootAvailable);
            const after = await registered();
            expect(after.text).toEqual(before.text);
        }
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
});
