import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oldPlugin = process.env.MC_PROBE_UPGRADE_FROM;
const adopted = process.env.MC_PROBE_EXPECT_ADOPTED === "1";
const lane = process.env.MC_GATE_BOUNDARY === "1" ? "marker-dropped-boundary" : "marker-drops";
// MC_PROBE_UPGRADE_FROM names the initial plugin entrypoint; restart reuses the same databases.
test.skipIf(!oldPlugin)(lane === "marker-dropped-boundary" ? "marker boundary upgrade loses exactly the rows below the pre-fix committed boundary, once" : adopted ? "scoped gate restart preserves adopted priced marker-seam prefix" : "scoped gate upgrade preserves pre-fix priced marker-seam prefix", () => {
    const output = mkdtempSync(join(tmpdir(), "scoped-upgrade-gate-"));
    execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
        env: { ...process.env, MC_PROBE_LANE: lane, MC_SPECIMEN_DIR: "" },
        timeout: 240_000, stdio: "pipe",
    });
    const bodies = JSON.parse(readFileSync(join(output, `${lane}-bodies.json`), "utf8"));
    expect(bodies).toHaveLength(3);
    const [a, b, c] = bodies.map((body: { messages: unknown[] }) => body.messages);
    const normalized = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
    const sha = (value: unknown) => createHash("sha256").update(normalized(value)).digest("hex");
    const firstDivergence = Array.from({ length: a.length }, (_, i) => i).find(i => normalized(a[i]) !== normalized(b[i])) ?? -1;
    const target = (messages: unknown[]) => messages.findIndex(message => JSON.stringify(message).includes("CKIOS_REASONING_ONLY"));
    const lines = (file: string) => readFileSync(join(output, file), "utf8").trim().split("\n").map(line => JSON.parse(line));
    // Each snapshot ends with the last raw hook array served at that point, so
    // the pre-upgrade pass, the first pass after it and the one after that are
    // identified by capture time rather than by counting from the end.
    const preUpgradeHooks = lines(`${lane}-pre-upgrade-after.jsonl`);
    const postRestartHooks = lines(`${lane}-post-restart-after.jsonl`);
    const allHooks = lines(`${lane}-after.jsonl`);
    const hookA = preUpgradeHooks[preUpgradeHooks.length - 1];
    const hookB = postRestartHooks[postRestartHooks.length - 1];
    const hookC = allHooks[allHooks.length - 1];
    const rawSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    // Row shape as Magic Context owns it. OpenCode re-reads its own message
    // records after a restart and re-adds bookkeeping of its own (an empty
    // `info.summary`), which never reaches the provider and which no transform
    // writes; comparing id/role/parts keeps the array-geometry claim (a row that
    // appears, disappears or changes parts still reddens) without asserting the
    // host's metadata is stable across its own restart.
    type HookRow = { info?: { id?: string; role?: string }; parts?: Array<{ type?: string; text?: string }> };
    const shape = (rows: HookRow[]) => rows.map(row => ({ id: row?.info?.id ?? null, role: row?.info?.role ?? null, parts: row?.parts ?? [] }));
    const hookFirstDivergence = Array.from({ length: hookA.length }, (_, i) => i).find(i => JSON.stringify(hookA[i]) !== JSON.stringify(hookB[i])) ?? -1;
    const hookShapeFirstDivergence = Array.from({ length: hookA.length }, (_, i) => i).find(i => JSON.stringify(shape([hookA[i]])) !== JSON.stringify(shape([hookB[i]]))) ?? -1;
    const preUpgradeLkg = JSON.parse(readFileSync(join(output, `${lane}-pre-upgrade-lkg.json`), "utf8")) as unknown[];
    const evidence = { output, aSha256: sha(a), bPrefixSha256: sha(b.slice(0, a.length)), firstDivergence, targetA: target(a), targetB: target(b), targetC: target(c), hookASha256: rawSha(hookA), hookBPrefixSha256: rawSha(hookB.slice(0, hookA.length)), hookFirstDivergence, hookShapeFirstDivergence, preUpgradeLkgRows: preUpgradeLkg.length };
    console.log(`SCOPED_GATE upgrade ${JSON.stringify(evidence)}`);
    writeFileSync(join(output, "gate-evidence.json"), JSON.stringify(evidence, null, 2));
    const log = readFileSync(join(output, `${lane}.log`), "utf8");
    const preLog = readFileSync(join(output, `${lane}-pre-upgrade.log`), "utf8");
    expect(preLog).toContain(`compaction-marker drain: applied at ordinal ${lane === "marker-dropped-boundary" ? 6 : 4}`);
    expect(preLog).toContain("decision=execute");
    const afterRestart = log.slice(preLog.length);
    expect(afterRestart).toContain("decision=defer");
    expect(afterRestart).not.toContain("decision=execute");
    expect(readFileSync(join(output, `${lane}-pre-upgrade-ledger.json`), "utf8").includes("@tool-sweep-scoped")).toBe(adopted);
    expect(target(a)).toBeGreaterThan(0);
    if (lane === "marker-dropped-boundary") {
        const fixture = JSON.parse(readFileSync(join(output, `${lane}-boundary-fixture.json`), "utf8"));
        expect(fixture.boundary.info.role).toBe("assistant");
        expect(fixture.boundary.parts.some((part: { type: string }) => part.type === "tool")).toBe(true);
        expect(fixture.tags).toHaveLength(1);
        expect(fixture.tags[0]).toMatchObject({ status: "dropped", drop_mode: "full", tool_owner_message_id: fixture.boundary.info.id });
        // The pre-fix build committed this boundary while still serving the rows
        // below it. The fixed build is handed the trimmed history and refuses to
        // re-serve rows the host no longer provides. Pin the bound of that one
        // paid transition: the rows that disappear are exactly the host rows
        // below the committed boundary, nothing above it moves out of order,
        // the reasoning target survives, and the next pass repeats the new
        // prefix instead of losing more.
        const storeOrder = (JSON.parse(readFileSync(join(output, `${lane}-store-before.json`), "utf8")) as Array<{ info: { id: string } }>).map(message => message.info.id);
        const boundaryIndex = storeOrder.indexOf(fixture.boundary.info.id);
        expect(boundaryIndex).toBeGreaterThan(0);
        const ids = (rows: Array<{ info?: { id?: string } }>) => rows.map(row => row?.info?.id).filter((id): id is string => typeof id === "string");
        const retained = new Set(ids(hookB));
        const lost = ids(hookA).filter(id => !retained.has(id));
        expect(lost.length).toBeGreaterThan(0);
        expect(lost.map(id => storeOrder.indexOf(id) >= 0 && storeOrder.indexOf(id) < boundaryIndex)).toEqual(lost.map(() => true));
        expect(ids(hookA).filter(id => storeOrder.indexOf(id) >= boundaryIndex && !retained.has(id))).toEqual([]);
        const survivors = (hookA as HookRow[]).filter(row => !row?.info?.id || retained.has(row.info.id));
        expect(rawSha(shape(hookB).slice(0, survivors.length))).toBe(rawSha(shape(survivors)));
        expect(target(b)).toBeGreaterThan(0);
        expect(target(b)).toBeLessThan(target(a));
    } else {
        expect(sha(b.slice(0, a.length))).toBe(sha(a));
        expect(target(b)).toBe(target(a));
        if (adopted) {
            // Same build on both sides of the restart: the array the hook serves
            // is reproduced row for row, not merely the provider view of it. An
            // emptied row that survives in one pass and is spliced in the next
            // reddens here even though the provider never sees it.
            expect(hookShapeFirstDivergence).toBe(-1);
            expect(rawSha(shape(hookB).slice(0, hookA.length))).toBe(rawSha(shape(hookA)));
        } else {
            // The pre-fix build left rows whose parts had all been removed in
            // the array it served; the host drops those before the request, so
            // the fixed build is not asked to reproduce them. Everything the
            // host does send is reproduced row for row.
            const sendable = (rows: Array<{ parts?: Array<{ type?: string; text?: string }> }>) => rows.filter(row => (row?.parts ?? []).some(part => part?.type !== "text" || (part?.text ?? "").trim().length > 0));
            expect(hookA.length - sendable(hookA).length).toBeGreaterThan(0);
            expect(sendable(hookB)).toHaveLength(hookB.length);
            expect(rawSha(shape(hookB).slice(0, sendable(hookA).length))).toBe(rawSha(shape(sendable(hookA))));
            // Why this session adopts rather than matching: the build that ran
            // before the upgrade saved no snapshot of the array it last served,
            // so neither candidate array can be checked against previously
            // served rows. That case is `lkg_absent`, and the pass records it
            // under the `tool_sweep_lkg_mismatch` key so the population of
            // sessions taking this route can be counted.
            expect(preUpgradeLkg).toEqual([]);
            expect(afterRestart).toContain("tool_sweep_lkg_mismatch");
            expect(afterRestart).toContain("condition=lkg_absent");
        }
    }
    // Whatever the first pass after the upgrade serves, the session keeps
    // serving it: the transition is paid once, not once per pass.
    expect(sha(c.slice(0, b.length))).toBe(sha(b));
    expect(rawSha(shape(hookC).slice(0, hookB.length))).toBe(rawSha(shape(hookB)));
}, 300_000);
