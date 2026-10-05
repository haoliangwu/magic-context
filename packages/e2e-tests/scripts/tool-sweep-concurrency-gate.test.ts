import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb } from "../src/test-db";

/**
 * Two real processes, one SQLite session: the priced process commits the scoped
 * sweep adoption marker while a defer process is mid-pass, and the reverse. A
 * defer pass must serve pre-adoption bytes for its whole pass or post-adoption
 * bytes for its whole pass — never a mixture of the two.
 */
test("scoped gate concurrent priced and defer processes never serve a mixed sweep", async () => {
    const home = mkdtempSync(join(tmpdir(), "tool-sweep-concurrency-"));
    const barrierDir = join(home, "barrier");
    mkdirSync(barrierDir, { recursive: true });
    const sessionId = "ses-sweep-concurrency";
    const script = join(import.meta.dir, "tool-sweep-concurrency-pass.ts");
    const dbPath = join(home, "cortexkit", "magic-context", "context.db");
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        // NODE_ENV=test silences the plugin logger; these passes are the place
        // the countable adoption line has to be observable.
        if (value !== undefined && key !== "NODE_ENV") childEnv[key] = value;
    }

    let passIndex = 0;
    const startPass = (decision: "execute" | "defer", role?: string) => {
        const label = `${passIndex++}-${decision}${role ? `-${role}` : ""}`;
        const out = join(home, `${label}.json`);
        const log = join(home, `${label}.log`);
        const child = Bun.spawn(
            [
                process.execPath,
                script,
                JSON.stringify({
                    dataHome: home,
                    sessionId,
                    decision,
                    out,
                    ...(role ? { barrierDir, role } : {}),
                }),
            ],
            { env: { ...childEnv, MAGIC_CONTEXT_LOG_PATH: log }, stdout: "pipe", stderr: "pipe" },
        );
        return {
            out,
            log,
            finished: (async () => {
                const code = await child.exited;
                if (code !== 0) {
                    throw new Error(
                        `${label} exited ${code}: ${await new Response(child.stderr).text()}`,
                    );
                }
                return JSON.parse(readFileSync(out, "utf8")) as Array<{
                    info: { id?: string };
                    parts: Array<{ type?: string }>;
                }>;
            })(),
        };
    };
    const runPass = async (decision: "execute" | "defer") => startPass(decision).finished;
    const waitFor = async (file: string) => {
        const deadline = Date.now() + 60_000;
        while (!existsSync(file)) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
            await Bun.sleep(25);
        }
    };
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const adopted = () => {
        const db = openTestDb(dbPath);
        try {
            const row = db
                .query("SELECT merged_reasoning_stripped_ids AS ids FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { ids: string | null } | undefined;
            return String(row?.ids ?? "").includes("@tool-sweep-scoped");
        } finally {
            db.close();
        }
    };

    // Seed: one pass mints the tags, then the tool arc is marked fully dropped.
    await runPass("defer");
    const seedDb = openTestDb(dbPath);
    try {
        seedDb
            .query("UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND type = 'tool'")
            .run(sessionId);
    } finally {
        seedDb.close();
    }
    // Pre-adoption reference, and the durable record of what was served.
    const legacyReference = await runPass("defer");
    expect(legacyReference.some((message) => message.info.id === "cc-thinking")).toBe(false);
    expect(adopted()).toBe(false);

    // Interleaving 1: the priced process commits adoption while the defer
    // process sits between its policy read and its sweep.
    const deferFirst = startPass("defer", "defer");
    await waitFor(join(barrierDir, "defer.parked"));
    await runPass("execute");
    expect(adopted()).toBe(true);
    writeFileSync(join(barrierDir, "defer.go"), "go");
    const servedDuringAdoption = await deferFirst.finished;

    // Interleaving 2: a whole defer pass runs inside a priced process's pass,
    // after that process has already committed the marker.
    const pricedParked = startPass("execute", "priced");
    await waitFor(join(barrierDir, "priced.parked"));
    const servedAfterAdoption = await runPass("defer");
    writeFileSync(join(barrierDir, "priced.go"), "go");
    await pricedParked.finished;
    const adoptedReference = await runPass("defer");

    console.log(
        `SCOPED_GATE concurrency legacy=${sha(legacyReference)} during=${sha(servedDuringAdoption)} after=${sha(servedAfterAdoption)} adopted=${sha(adoptedReference)}`,
    );
    // The two coherent outcomes are distinguishable, so each equality below is
    // a real claim rather than a tautology.
    expect(sha(legacyReference)).not.toBe(sha(adoptedReference));
    expect(adoptedReference.find((message) => message.info.id === "cc-thinking")?.parts.some((part) => part.type === "reasoning")).toBe(true);

    // Whole-pass pre-adoption bytes.
    expect(sha(servedDuringAdoption)).toBe(sha(legacyReference));
    expect(sha(servedDuringAdoption)).not.toBe(sha(adoptedReference));
    expect(servedDuringAdoption.some((message) => message.info.id === "cc-thinking")).toBe(false);
    // Whole-pass post-adoption bytes.
    expect(sha(servedAfterAdoption)).toBe(sha(adoptedReference));
    expect(sha(servedAfterAdoption)).not.toBe(sha(legacyReference));

    // The pre-adoption pass logged its countable decision.
    expect(readFileSync(deferFirst.log, "utf8")).toContain("tool_sweep_lkg_mismatch");
}, 180_000);
