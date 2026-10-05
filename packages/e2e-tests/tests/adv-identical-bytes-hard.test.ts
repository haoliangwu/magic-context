/**
 * Adversarial gate drive (real OpenCode 1 host): an executed HARD fold that
 * re-renders m[0]/m[1] byte-identically (a project-memory epoch bump with no
 * content change) must not let a queued ctx_reduce drop ride it, the defer
 * passes after it must replay the same bytes, and the held drop must land at
 * the next genuine bust (here the >=85% force band). A content-changing epoch
 * HARD must then land a second queued drop, and the defer after it must replay
 * the HARD's bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";

const LOW = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0 };
const FORCE = { input_tokens: 17_600, output_tokens: 10, cache_creation_input_tokens: 0 };

const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key]) => key !== "cache_control")
                .map(([key, inner]) => [key, strip(inner)]),
        );
    }
    return value;
};
const sha = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(strip(value))).digest("hex");

describe("ADV identical-bytes HARD on OpenCode 1", () => {
    let h: TestHarness;

    beforeAll(async () => {
        h = await TestHarness.create({
            modelContextLimit: 20_000,
            magicContextConfig: {
                execute_threshold_percentage: 80,
                historian: { disable: true },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("holds the drop on an identical HARD, then lands it at the force band", async () => {
        let toolTurn = true;
        let usage = LOW;
        h.mock.reset();
        h.mock.addMatcher((body): MockResponse | null => {
            const bash = (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find((name): name is string => typeof name === "string" && /(^|_)bash$/.test(name));
            if (!bash || !toolTurn) return null;
            const messages = (body.messages ?? []) as unknown[];
            const calls = JSON.stringify(messages).match(/"tool_use"/g)?.length ?? 0;
            if (calls >= 3) return null;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: `toolu_adv_${calls}`,
                        name: bash,
                        input: { command: `echo ${"z".repeat(1500)}${calls}`, description: `c${calls}` },
                    },
                ],
                stop_reason: "tool_use",
                usage: LOW,
            };
        });
        h.mock.addMatcher(() => ({ text: "ok", usage }));

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run three commands", { timeoutMs: 240_000 });
        await h.waitForMockQuiescence({ label: "tool turn settles" });
        toolTurn = false;

        const db = () => openTestDb(h.contextDbPath());
        const tagOf = (callId: string) => {
            const r = db();
            try {
                return r
                    .prepare(
                        "SELECT tag_number AS tag, status FROM tags WHERE session_id = ? AND harness = ? AND type = 'tool' AND message_id = ?",
                    )
                    .get(sessionId, h.harnessId, callId) as { tag: number; status: string } | null;
            } finally {
                r.close();
            }
        };
        const pendingCount = () => {
            const r = db();
            try {
                return (
                    r
                        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                        .get(sessionId) as { n: number }
                ).n;
            } finally {
                r.close();
            }
        };
        const queue = (tag: number) => {
            const w = db();
            try {
                w.prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
                ).run(sessionId, tag, Date.now(), h.harnessId);
            } finally {
                w.close();
            }
        };
        const identity = () => {
            const r = db();
            try {
                return (
                    r
                        .prepare(
                            "SELECT cached_m0_project_identity AS id, cached_m0_project_memory_epoch AS epoch, cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { id: string; epoch: number | null; at: number | null }
                );
            } finally {
                r.close();
            }
        };
        // Upsert the project's memory epoch the way bumpProjectMemoryEpoch does.
        const bumpEpoch = () => {
            const w = db();
            try {
                return w
                    .prepare(
                        `INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
                         VALUES (?, 1, 0, ?)
                         ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = project_memory_epoch + 1, updated_at = excluded.updated_at`,
                    )
                    .run(identity().id, Date.now()).changes;
            } finally {
                w.close();
            }
        };
        const turn = async (label: string) => {
            await h.sendPrompt(sessionId, `${label} prompt`, { timeoutMs: 120_000 });
            await h.waitForMockQuiescence({ label });
            const last = h.requests().at(-1)!;
            return (last.body.messages ?? []) as unknown[];
        };
        const shared = (messages: unknown[], prefix: unknown[]) =>
            sha(messages.slice(0, prefix.length)) === sha(prefix);

        const base = await turn("defer-0");
        const target = tagOf("toolu_adv_0");
        expect(target).not.toBeNull();
        queue(target!.tag);
        const held = await turn("defer-held");

        const beforeHard = identity();
        const bumped = bumpEpoch();
        const identicalHard = await turn("identical-hard");
        const afterHard = identity();
        const afterIdentical = [await turn("defer-1"), await turn("defer-2")];
        const statusAfterIdentical = tagOf("toolu_adv_0")?.status;
        const pendingAfterIdentical = pendingCount();

        usage = FORCE;
        await turn("reach-force");
        const force = await turn("force-pass");
        usage = LOW;
        const statusAfterForce = tagOf("toolu_adv_0")?.status;
        const afterForce = await turn("defer-after-force");

        // Content-changing epoch HARD with a second queued drop.
        const target2 = tagOf("toolu_adv_1");
        queue(target2!.tag);
        const insertRes = { projectPath: identity().id };
        let realHard: unknown[] | null = null;
        let afterReal: unknown[] | null = null;
        let realHardError: string | null = null;
        try {
            const { insertMemory } = await import(
                "../../plugin/src/features/magic-context/memory/storage-memory"
            );
            const w = db();
            try {
                insertMemory(w as never, {
                    projectPath: insertRes.projectPath!,
                    category: "PROJECT_RULES",
                    content: "ADV_REAL_HARD: a new project rule.",
                    importance: 50,
                });
                w.prepare(
                    "UPDATE project_state SET project_memory_epoch = project_memory_epoch + 1, updated_at = ?",
                ).run(Date.now());
            } finally {
                w.close();
            }
            realHard = await turn("real-hard");
            afterReal = await turn("defer-after-real");
        } catch (error) {
            realHardError = String(error);
        }

        const summary = {
            projectStateRowsBumped: bumped,
            identicalHardFolded: {
                epochBefore: beforeHard.epoch,
                epochAfter: afterHard.epoch,
                materializedAtChanged: beforeHard.at !== afterHard.at,
            },
            heldEqualsBase: shared(held, base),
            identicalHardEqualsHeld: sha(identicalHard) === sha(held.concat(identicalHard.slice(held.length))) && shared(identicalHard, held),
            identicalHardHeadEqualsHeld: sha(identicalHard.slice(0, 2)) === sha(held.slice(0, 2)),
            defersExtendIdenticalHard: afterIdentical.map((m) => shared(m, identicalHard)),
            statusAfterIdentical,
            pendingAfterIdentical,
            statusAfterForce,
            forceChangedPrefix: !shared(force, afterIdentical[1]!),
            deferAfterForceExtendsForce: shared(afterForce, force),
            realHardError,
            realHardHeadChanged: realHard ? sha(realHard.slice(0, 2)) !== sha(afterForce.slice(0, 2)) : null,
            statusTarget2AfterReal: tagOf("toolu_adv_1")?.status,
            deferAfterRealExtendsReal: realHard && afterReal ? shared(afterReal, realHard) : null,
        };
        console.log("ADV_OC1_IDENTICAL_HARD", JSON.stringify(summary, null, 1));
        const lsof = execFileSync("lsof", ["-p", String(h.opencode.pid)], { encoding: "utf8" })
            .split("\n")
            .filter((line) => /\.db(-wal|-shm)?$/.test(line))
            .join("\n");
        console.log("ADV_OC1_LSOF_DB\n" + lsof);
        const evidenceDir = process.env.ADV_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            writeFileSync(join(evidenceDir, "adv-oc1-identical-hard.json"), JSON.stringify(summary, null, 2));
            writeFileSync(join(evidenceDir, "adv-oc1-identical-hard-lsof-db.txt"), lsof);
        }
        expect(summary.identicalHardFolded.materializedAtChanged).toBe(true);
        expect(summary.heldEqualsBase).toBe(true);
        expect(summary.identicalHardHeadEqualsHeld).toBe(true);
        expect(statusAfterIdentical).toBe("active");
        expect(pendingAfterIdentical).toBe(1);
        expect(summary.defersExtendIdenticalHard).toEqual([true, true]);
        expect(statusAfterForce).toBe("dropped");
        expect(summary.deferAfterForceExtendsForce).toBe(true);
    }, 900_000);
});
