import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test as decisions } from "../src/features/magic-context/transform-decision-log";
import { dropSlot } from "../src/hooks/magic-context/lkg-slot";
import { rustRawRebuild } from "../src/hooks/magic-context/rust-served-raw";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import { tryMessagesTransformLkgReplay } from "../src/plugin/messages-transform";
import { hostFixture, providerBody, scratch, tool, user } from "./rust-cache-harness";

const binary = process.env.MC_RAW_REPLAY_PROBE;
const phase = process.env.MC_R2_CHILD_PHASE;
const cases = ["deletion", "revert", "synthetic-change", "candidate-loss"] as const;

if (!binary && !phase) {
    const reason = "Rust restart raw replay tests require staged MC_RAW_REPLAY_PROBE";
    if (process.env.MC_RAW_REPLAY_REQUIRED === "1") throw new Error(`Required ${reason}`);
    console.info(`SKIP ${reason}`);
    test.skip("raw replay restart coverage requires MC_RAW_REPLAY_PROBE", () => {});
}

if (phase) {
    test("recovery process child", async () => {
        const root = process.env.MC_R2_CHILD_ROOT!;
        const change = process.env.MC_R2_CHILD_CHANGE!;
        const sid = `r2-kill-${change}`;
        mkdirSync(join(root, "module"), { recursive: true });
        const fixture = await hostFixture(sid, binary!, undefined, undefined, false, {
            directory: join(root, "module"),
            dbPath: join(root, "host.db"),
        });
        let input: MessageLike[];
        if (phase === "refuse") {
            input = [user(sid, "initial")];
            await fixture.run(input);
            const raw = tool(sid, "raw");
            raw.parts.push({ type: "text", synthetic: true, text: "old killed-process reminder" });
            input.push(raw);
            const replay = { messages: structuredClone(input) } as Parameters<
                typeof tryMessagesTransformLkgReplay
            >[0]["output"];
            expect(
                tryMessagesTransformLkgReplay({
                    output: replay,
                    sessionId: sid,
                    error: new Error("offline outage"),
                    rust: fixture.host.replayParticipant,
                }),
            ).toBe(true);
            await fixture.run(input);
            if (change === "deletion" || change === "revert") input.pop();
            if (change !== "revert") dropSlot(sid, "message_removed");
            if (change === "synthetic-change")
                (raw.parts[1] as { text: string }).text = "new killed-process reminder";
            input.push(user(sid, "continued"));
        } else input = JSON.parse(readFileSync(join(root, "ingress.json"), "utf8"));
        if (change === "candidate-loss")
            fixture.mutate = (response) => {
                response.native_messages = (response.native_messages as MessageLike[]).filter(
                    (message) => message.info.id !== "raw",
                );
            };
        if (phase === "refuse") {
            await expect(fixture.run(input)).rejects.toThrow();
            const obligation = rustRawRebuild(fixture.db, sid);
            expect(obligation?.pending).toBe(true);
            writeFileSync(join(root, "ingress.json"), JSON.stringify(input));
            writeFileSync(join(root, "obligation.json"), JSON.stringify(obligation));
            // The parent kills this process before test teardown or a recovery pass can run.
            console.info("R2_REFUSAL_DURABLE_READY");
            const keepAlive = setInterval(() => {}, 1000);
            try {
                await new Promise<never>(() => {});
            } finally {
                clearInterval(keepAlive);
            }
        }
        const previous = JSON.parse(readFileSync(join(root, "obligation.json"), "utf8"));
        expect(rustRawRebuild(fixture.db, sid)).toEqual(previous);
        let stable: string | undefined;
        let rebuilds = 0;
        const evidence: unknown[] = [];
        for (let pass = 0; pass < 12; pass++) {
            const body = await providerBody(await fixture.run(input));
            const rebuilding =
                fixture.response.materialize_reason === "raw_replay_identity_rebuild";
            if (rebuilding) {
                rebuilds++;
                expect(pass).toBe(0);
                expect(fixture.response.prefix_bust_permitted).toBe(true);
                expect(decisions.getPending(sid)?.lkgFrozenReleaseReason).toStartWith(
                    `raw_replay_${previous.reason};first_changed=raw#`,
                );
            } else {
                expect(fixture.response.prefix_bust_permitted).toBe(false);
                expect(fixture.request.raw_replay_rebuild).toBeUndefined();
            }
            expect(rustRawRebuild(fixture.db, sid)).toMatchObject({
                identity: previous.identity,
                pending: false,
            });
            if (stable !== undefined) expect(body).toBe(stable);
            stable = body;
            if (change === "deletion" || change === "revert") {
                expect(body).not.toContain("raw-call");
                expect(body).not.toContain("output raw");
            }
            if (change !== "candidate-loss")
                expect(body).not.toContain("old killed-process reminder");
            if (change === "synthetic-change")
                expect(body).toContain("new killed-process reminder");
            if (change === "candidate-loss") expect(body).toContain("output raw");
            evidence.push({
                pass,
                rebuilding,
                reason: decisions.getPending(sid)?.lkgFrozenReleaseReason,
            });
        }
        expect(rebuilds).toBe(1);
        console.info(
            JSON.stringify({
                processRestart: change,
                refusalsBeforeKill: 1,
                refusalsAfterKill: 0,
                rebuilds,
                evidence,
            }),
        );
    }, 120_000);
}

if (binary && !phase) {
    for (const change of cases) {
        test(`SIGKILL after ${change} refusal preserves exactly one rebuild`, async () => {
            const root = scratch(`r2-process-${change}-`);
            const spawn = (next: string) =>
                Bun.spawn(
                    [
                        process.execPath,
                        "test",
                        fileURLToPath(import.meta.url),
                        "-t",
                        "^recovery process child$",
                    ],
                    {
                        env: {
                            ...process.env,
                            MC_R2_CHILD_ROOT: root,
                            MC_R2_CHILD_PHASE: next,
                            MC_R2_CHILD_CHANGE: change,
                        },
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
            const child = spawn("refuse");
            const stderr = new Response(child.stderr).text();
            let output = "";
            const reader = child.stdout.getReader();
            try {
                while (!output.includes("R2_REFUSAL_DURABLE_READY")) {
                    const part = await reader.read();
                    if (part.done)
                        throw new Error(
                            `child exited before durable refusal: ${output} ${await stderr}`,
                        );
                    output += new TextDecoder().decode(part.value);
                }
            } finally {
                child.kill("SIGKILL");
            }
            await child.exited;
            expect(child.signalCode).toBe("SIGKILL");
            const resumed = spawn("resume");
            const [out, err, code] = await Promise.all([
                new Response(resumed.stdout).text(),
                new Response(resumed.stderr).text(),
                resumed.exited,
            ]);
            console.info(out);
            expect(code, err).toBe(0);
            expect(out).toContain(`"processRestart":"${change}"`);
        }, 120_000);
    }
}
