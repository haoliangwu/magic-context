import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
    assertNoZenCarrierLeak,
    capturePrimaryRequests,
    primarySurface,
} from "../src/primary-request-capture";

const root = process.env.MC_PRIMARY_PROBE_ROOT;
const baseline = process.env.MC_PRIMARY_BASE_PLUGIN;
const current = process.env.MC_PRIMARY_CURRENT_PLUGIN ?? resolve(import.meta.dir, "../../plugin");
const cli = [process.env.MC_PRIMARY_OC1, process.env.MC_PRIMARY_OC2];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

for (const [surface, body] of [
    ["system", { system: "Available agents: historian-zen-blocked-read" }],
    [
        "tool description",
        { tools: [{ name: "Task", description: "Use historian-zen-blocked-read" }] },
    ],
    [
        "callable-agent enum",
        { tools: [{ input_schema: { enum: ["historian-zen-blocked-read"] } }] },
    ],
    ["@-agent listing", { messages: [{ role: "user", content: "@historian-zen-blocked-read" }] }],
] as const) {
    test(`primary request guard rejects a carrier in ${surface}`, () => {
        expect(() => assertNoZenCarrierLeak(body)).toThrow("Ordinary primary request exposes");
        expect(() =>
            assertNoZenCarrierLeak({
                system: "ordinary context",
                tools: [{ name: "Task", description: "Use public-reviewer" }],
            }),
        ).not.toThrow();
    });
}

for (const generation of [1, 2] as const) {
    const enabled = Boolean(root && baseline && cli[generation - 1]);
    const version = generation === 1 ? "1.19.3" : "2.0.31";
    // Set MC_PRIMARY_OC1/OC2 to the pinned CLI executables, MC_PRIMARY_BASE_PLUGIN
    // to a built baseline package, and MC_PRIMARY_PROBE_ROOT to a private scratch
    // parent. MC_PRIMARY_CURRENT_PLUGIN optionally overrides the current package.
    // Normal unit runs skip these two host tests when those inputs are absent.
    (enabled ? test : test.skip)(
        `primary cache surface stays unchanged on OpenCode ${version}`,
        async () => {
            if (!root || !baseline || !cli[generation - 1])
                throw new Error("Native primary capture inputs are missing");
            mkdirSync(root, { recursive: true, mode: 0o700 });
            const scratch = createTestTempDirFromPath(join(root, `oc${generation}-`));
            const entry = (plugin: string) =>
                generation === 1 ? join(plugin, "dist/index.js") : join(plugin, "dist/v2");
            try {
                const before = await capturePrimaryRequests({
                    generation,
                    cli: cli[generation - 1]!,
                    plugin: entry(baseline),
                    root: scratch,
                    label: "baseline",
                });
                const after = await capturePrimaryRequests({
                    generation,
                    cli: cli[generation - 1]!,
                    plugin: entry(current),
                    root: scratch,
                    label: "current",
                });
                const visible = (agents: typeof before.agents) =>
                    agents
                        .filter((agent) => !agent.hidden)
                        .map((agent) => agent.id)
                        .sort();
                expect(visible(before.agents)).toContain("explore");
                expect(
                    after.agents.filter((agent) => agent.id.endsWith("-zen-blocked-read")),
                ).toHaveLength(generation === 1 ? 6 : 0);
                const comparisons = before.rawBodies.map((raw, turn) => {
                    const next = after.rawBodies[turn]!;
                    const oldBody = JSON.parse(raw),
                        newBody = JSON.parse(next);
                    assertNoZenCarrierLeak(oldBody);
                    assertNoZenCarrierLeak(newBody);
                    const oldSurface = primarySurface(raw),
                        newSurface = primarySurface(next);
                    const tools = newSurface.tools as Array<{ name: string; description: string }>;
                    const delegation = tools.find((tool) => /^(task|subagent)$/i.test(tool.name));
                    expect(delegation?.description.toLowerCase()).toContain("explore");
                    expect(JSON.stringify(newSurface.system)).toBe(
                        JSON.stringify(oldSurface.system),
                    );
                    expect(JSON.stringify(newSurface.tools)).toBe(JSON.stringify(oldSurface.tools));
                    expect(JSON.stringify(newSurface.messages)).toBe(
                        JSON.stringify(oldSurface.messages),
                    );
                    expect(next).toBe(raw);
                    return {
                        turn,
                        bytes: Buffer.byteLength(raw),
                        baselineSha256: digest(raw),
                        currentSha256: digest(next),
                        systemSha256: digest(JSON.stringify(newSurface.system)),
                        toolsSha256: digest(JSON.stringify(newSurface.tools)),
                        toolNames: tools.map((tool) => tool.name),
                        delegationTool: delegation,
                        delegationSha256: digest(JSON.stringify(delegation)),
                    };
                });
                expect(visible(after.agents)).toEqual(visible(before.agents));
                const summary = {
                    host: version,
                    magicContextLoaded: true,
                    magicContextProcessed: before.processed && after.processed,
                    visibleAgents: visible(after.agents),
                    hiddenZenCarriers: after.agents.filter((agent) =>
                        agent.id.endsWith("-zen-blocked-read"),
                    ),
                    comparisons,
                    inventories: [...before.databases, ...after.databases],
                };
                writeFileSync(join(scratch, "summary.json"), JSON.stringify(summary, null, 2));
                console.log(`[primary-cache-proof] ${JSON.stringify(summary)}`);
            } finally {
                // Preserve evidence outside the registered test directory's exit cleanup.
                const evidence = join(root, "evidence", `oc${generation}`);
                mkdirSync(join(root, "evidence"), { recursive: true });
                rmSync(evidence, { recursive: true, force: true });
                cpSync(scratch, evidence, { recursive: true });
            }
        },
        300000,
    );
}
