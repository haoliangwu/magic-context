/// <reference types="bun-types" />

/**
 * Incident regression #4: consecutive module failures parked the adapter
 * permanently while every dashboard read green.
 *
 * The bug: when the module became unavailable (or rejected) for a stretch, the
 * adapter parked the session after three consecutive failures and never
 * recovered — usage climbed past threshold with zero folds. The park self-heal
 * fix (now MERGED into this branch's base) re-primes and resumes serving once the
 * module is healthy again, and arms park recovery on pressure (a parked session
 * retries sooner at ≥90% usage) with a fail-closed abort at ≥95% so it never
 * replays stale bytes into a provider-proven overflow.
 *
 * This file has TWO arms exercising different fault shapes; both assert the
 * shipped OUTCOME (no permanent park; transform resumes) not the mechanism:
 *
 *  A. module-restart recovery — kill and restart the ck-mc module mid-session
 *     against the same daemon + store. The raw array is unchanged, so the
 *     adapter's ordinal state stays valid; the only failure window is the brief
 *     reconnect. A module restart mid-session must recover on the following
 *     passes with no permanent degradation.
 *
 *  B. park-then-heal — force three+ consecutive failures so the adapter actually
 *     PARKS (module killed and kept down), then restore the module and assert the
 *     session un-parks and resumes serving. This is the arm the merged
 *     park-self-heal fix makes pass; before it, a prolonged outage parked
 *     permanently and never recovered.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { RUST_REFUSAL_RECOVERY_PROMPT } from "../../plugin/src/hooks/magic-context/rust-refusal-recovery";
import { RustTestHarness } from "../src/rust-harness";
import {
    driveToSteadyState,
    rustPrereqs,
    sessionLogLines,
} from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust incident regression: park self-heal", () => {
    let h: RustTestHarness;

    async function statusSnapshot(sessionId: string, method: "status" | "session.status"): Promise<string> {
        return Promise.race([
            h.subc
                .moduleStatus(sessionId, h.env.workdir, method)
                .then((value) => JSON.stringify(value))
                .catch((error) => `${method} failed: ${String(error)}`),
            Bun.sleep(5_000).then(() => `${method} timed out after 5000ms`),
        ]);
    }

    async function rethrowWithDiagnostics(sessionId: string, error: unknown): Promise<never> {
        let pluginLog = "";
        try {
            pluginLog = readFileSync(h.logPath, "utf8").slice(-8_000);
        } catch {
            // OpenCode can fail before plugin initialization creates the log.
        }
        let messageSnapshot = "unavailable";
        try {
            const messages = await h.listMessages(sessionId);
            messageSnapshot = JSON.stringify(
                messages.slice(-8).map((message) => ({
                    info: message.info,
                    parts: message.parts?.map((part) => {
                        const row = part as Record<string, unknown>;
                        return {
                            type: row.type,
                            text:
                                typeof row.text === "string" ? row.text.slice(0, 160) : undefined,
                            synthetic: row.synthetic,
                            ignored: row.ignored,
                        };
                    }),
                })),
            );
        } catch (snapshotError) {
            messageSnapshot = `failed: ${String(snapshotError)}`;
        }
        const [status, sessionStatus] = await Promise.all([
            statusSnapshot(sessionId, "status"),
            statusSnapshot(sessionId, "session.status"),
        ]);
        const sessionLogTail = sessionLogLines(h, sessionId).slice(-80).join("\n");
        throw new Error(
            `park self-heal failed: ${String(error)}\n` +
                `status: ${status}\n` +
                `session store state: ${sessionStatus}\n` +
                `OpenCode message snapshot: ${messageSnapshot}\n` +
                `rust passes: ${JSON.stringify(h.readRustPasses().map((pass) => pass.raw))}\n` +
                `session MC log tail:\n${sessionLogTail}\n` +
                `module log:\n${h.subc.moduleLog().slice(-8_000)}\n` +
                `daemon log:\n${h.subc.daemonLog().slice(-8_000)}\n` +
                `plugin log:\n${pluginLog}`,
        );
    }

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    // Arm A — always active where prereqs are met.
    it("recovers after a mid-session module restart without permanent degradation", async () => {
        const sessionId = await h.createSession();
        try {
            await driveToSteadyState(h, sessionId, 3);

            const before = h.readRustPasses();
            expect(before.some((p) => p.servedFrom === "transform")).toBe(true);
            const beforeCount = before.length;

            // Kill and restart the module against the same daemon + store. This is the
            // clean fault-injection window the daemon supervises: the store's
            // single-writer lease is released and re-acquired, and the plugin's subc
            // client transparently reconnects on its next call.
            await h.subc.restartModule();
            await Bun.sleep(500);

            // Subsequent passes must recover. The first may fail during the reconnect
            // window; what matters is the session does not permanently degrade.
            for (let i = 4; i <= 7; i += 1) {
                h.mock.setDefault({
                    text: `post-restart assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `post-restart turn ${i}: ${h.ballast(400)}`, {
                    timeoutMs: 30_000,
                });
                await Bun.sleep(300);
            }

            const all = await h.waitForRustPasses(beforeCount + 4);
            const after = all.slice(beforeCount);

            // Wedge-free recovery: the module served real transforms again after the
            // restart, and the session is not left permanently parked.
            expect(after.some((p) => p.servedFrom === "transform")).toBe(true);
            expect(after.at(-1)!.decision).not.toBe("parked");
        } catch (error) {
            await rethrowWithDiagnostics(sessionId, error);
        }
    }, 300_000);

    it(
        "resumes a refused turn exactly once when the module reconnects",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 1);
            h.mock.setDefault({
                text: "high pressure accepted",
                usage: {
                    input_tokens: 96_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, `arm accepted pressure: ${h.ballast(400)}`);
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { last_context_percentage?: number } | undefined;
                    return (row?.last_context_percentage ?? 0) >= 95;
                },
                { label: "accepted high-pressure usage persisted" },
            );

            await h.subc.killModuleAndWait();
            try {
                await h.sendPrompt(sessionId, "refuse this step while the module is down", {
                    timeoutMs: 30_000,
                });
            } catch {
                // OpenCode may return the transform refusal as a rejected SDK call.
            }
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).some((line) =>
                        line.includes("rust refusal recovery armed"),
                    ),
                { label: "post-refusal recovery watcher armed" },
            );

            const providerRequestsBeforeRecovery = h.mainRequests().length;
            h.mock.setDefault({
                text: "continued after reconnect",
                usage: {
                    input_tokens: 2_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 100,
                },
            });
            await h.subc.restoreModule();
            try {
                const recoveryMessage = await h.waitFor(
                    async () => {
                        const messages = await h.listMessages(sessionId);
                        return (
                            messages.find(
                                (message) =>
                                    typeof message.info?.id === "string" &&
                                    message.parts?.some(
                                        (part) =>
                                            part.type === "text" &&
                                            part.text === RUST_REFUSAL_RECOVERY_PROMPT,
                                    ),
                            ) ?? null
                        );
                    },
                    { timeoutMs: 30_000, label: "synthetic recovery prompt persisted" },
                );
                const recoveryMessageId = recoveryMessage.info?.id;
                if (!recoveryMessageId) {
                    throw new Error("synthetic recovery prompt has no message id");
                }
                const recoveryPart = recoveryMessage.parts?.find(
                    (part) => part.type === "text" && part.text === RUST_REFUSAL_RECOVERY_PROMPT,
                );
                expect(recoveryPart?.synthetic).toBe(true);
                expect(recoveryPart?.ignored).toBeUndefined();
                await h.waitFor(
                    async () => {
                        if (h.mainRequests().length > providerRequestsBeforeRecovery) return true;
                        const messages = await h.listMessages(sessionId);
                        return messages.some(
                            (message) =>
                                message.info?.role === "assistant" &&
                                message.info.parentID === recoveryMessageId,
                        );
                    },
                    { timeoutMs: 30_000, label: "synthetic recovery turn started" },
                );
                await h.waitFor(() => h.mainRequests().length > providerRequestsBeforeRecovery, {
                    timeoutMs: 30_000,
                    label: "started recovery turn reached the provider",
                });
                await Bun.sleep(2_500);

                const messages = await h.listMessages(sessionId);
                const recoveryPrompts = messages.filter((message) =>
                    message.parts?.some(
                        (part) =>
                            part.type === "text" && part.text === RUST_REFUSAL_RECOVERY_PROMPT,
                    ),
                );
                expect(recoveryPrompts).toHaveLength(1);
            } catch (error) {
                await rethrowWithDiagnostics(sessionId, error);
            }
        },
        300_000,
    );

    it(
        "does not resume when a newer real user message arrives before reconnect",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 1);
            h.mock.setDefault({
                text: "high pressure accepted",
                usage: {
                    input_tokens: 96_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, `arm user-race pressure: ${h.ballast(400)}`);
            await h.subc.killModuleAndWait();
            await h
                .sendPrompt(sessionId, "refuse before a newer user message", { timeoutMs: 30_000 })
                .catch(() => undefined);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).some((line) =>
                        line.includes("rust refusal recovery armed"),
                    ),
                { label: "user-race recovery watcher armed" },
            );

            const client = h.client as unknown as {
                session: {
                    promptAsync(input: {
                        path: { id: string };
                        body: { noReply: boolean; parts: Array<{ type: "text"; text: string }> };
                    }): Promise<unknown>;
                };
            };
            await client.session.promptAsync({
                path: { id: sessionId },
                body: {
                    noReply: true,
                    parts: [{ type: "text", text: "newer operator message" }],
                },
            });
            const providerRequestsBeforeRecovery = h.mainRequests().length;
            await h.subc.restoreModule();
            await Bun.sleep(4_500);

            const messages = await h.listMessages(sessionId);
            expect(
                messages.some((message) =>
                    message.parts?.some((part) => part.text === "newer operator message"),
                ),
            ).toBe(true);
            expect(
                messages.some((message) =>
                    message.parts?.some((part) => part.text === RUST_REFUSAL_RECOVERY_PROMPT),
                ),
            ).toBe(false);
            expect(h.mainRequests()).toHaveLength(providerRequestsBeforeRecovery);
        },
        300_000,
    );

    it(
        "does not resume a provider-proven emergency at accepted high pressure",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 1);
            h.mock.setDefault({
                text: "high pressure accepted",
                usage: {
                    input_tokens: 96_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, `arm provider pressure: ${h.ballast(400)}`);

            const overflowPrompt = "prove provider overflow before reconnect refusal";
            let overflowSent = false;
            h.mock.addMatcher((body) => {
                if (overflowSent || !JSON.stringify(body.messages ?? []).includes(overflowPrompt)) {
                    return null;
                }
                overflowSent = true;
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message:
                            "This model's maximum context length is 80000 tokens. Please reduce the length of the messages.",
                    },
                };
            });
            await h.sendPrompt(sessionId, overflowPrompt).catch(() => undefined);
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT needs_emergency_recovery FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { needs_emergency_recovery?: number } | undefined;
                    return overflowSent && row?.needs_emergency_recovery === 1;
                },
                { label: "provider-proven emergency persisted" },
            );

            await h.subc.killModuleAndWait();
            const logCount = sessionLogLines(h, sessionId).length;
            await h
                .sendPrompt(sessionId, "provider-proven refusal while module is down", {
                    timeoutMs: 30_000,
                })
                .catch(() => undefined);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId)
                        .slice(logCount)
                        .some((line) => line.includes("mc_rust_emergency_refusal before_lkg")),
                { label: "provider-proven reconnect refusal" },
            );
            const providerRequestsBeforeRecovery = h.mainRequests().length;
            await h.subc.restoreModule();
            await Bun.sleep(4_500);

            const messages = await h.listMessages(sessionId);
            expect(
                messages.some((message) =>
                    message.parts?.some((part) => part.text === RUST_REFUSAL_RECOVERY_PROMPT),
                ),
            ).toBe(false);
            expect(h.mainRequests()).toHaveLength(providerRequestsBeforeRecovery);
        },
        300_000,
    );

    it(
        "cancels refused-turn recovery when the session is deleted",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 1);
            h.mock.setDefault({
                text: "high pressure accepted",
                usage: {
                    input_tokens: 96_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, `arm deletion pressure: ${h.ballast(400)}`);
            await h.subc.killModuleAndWait();
            await h
                .sendPrompt(sessionId, "refuse before deletion", { timeoutMs: 30_000 })
                .catch(() => undefined);
            await h.waitFor(
                () =>
                    sessionLogLines(h, sessionId).some((line) =>
                        line.includes("rust refusal recovery armed"),
                    ),
                { label: "deletion recovery watcher armed" },
            );

            const deletion = await fetch(`${h.opencode.url}/session/${sessionId}`, {
                method: "DELETE",
            });
            expect(deletion.ok).toBe(true);
            const providerRequestsBeforeRecovery = h.mainRequests().length;
            await h.subc.restoreModule();
            await Bun.sleep(4_500);

            expect(
                sessionLogLines(h, sessionId).some((line) =>
                    line.includes("rust refusal recovery synthetic continue delivered"),
                ),
            ).toBe(false);
            expect(h.mainRequests()).toHaveLength(providerRequestsBeforeRecovery);
        },
        300_000,
    );

    // Prove that a session parked by repeated transport failures resumes once
    // the module is healthy, without recreating the OpenCode session.
    it(
        "un-parks and resumes serving after the module recovers from a prolonged outage",
        async () => {
            const sessionId = await h.createSession();
            try {
                await driveToSteadyState(h, sessionId, 3);
                const beforeCount = h.readRustPasses().length;

                // Prolonged outage: kill the module and keep it down across several
                // passes so the adapter crosses its three-failure park threshold.
                await h.subc.killModuleAndWait();
                for (let i = 4; i <= 8; i += 1) {
                    h.mock.setDefault({
                        text: `outage assistant ${i}`,
                        usage: {
                            input_tokens: 2_000 * i,
                            output_tokens: 20,
                            cache_creation_input_tokens: 1_000,
                        },
                    });
                    await h.sendPrompt(sessionId, `outage turn ${i}: ${h.ballast(400)}`, {
                        timeoutMs: 30_000,
                    });
                    await Bun.sleep(300);
                }

                // Restore the module and drive enough passes for the self-heal probe
                // cadence to retry and recover.
                await h.subc.restartModule();
                await Bun.sleep(500);
                for (let i = 9; i <= 18; i += 1) {
                    h.mock.setDefault({
                        text: `recovery assistant ${i}`,
                        usage: {
                            input_tokens: 2_000 * i,
                            output_tokens: 20,
                            cache_creation_input_tokens: 1_000,
                        },
                    });
                    await h.sendPrompt(sessionId, `recovery turn ${i}: ${h.ballast(400)}`, {
                        timeoutMs: 30_000,
                    });
                    await Bun.sleep(300);
                }

                const all = await h.waitForRustPasses(beforeCount + 15);
                const recovery = all.slice(beforeCount + 5);

                // Outcome: after the module recovers the session un-parks and serves
                // real transforms again — no permanent park.
                expect(recovery.some((p) => p.servedFrom === "transform")).toBe(true);
                expect(recovery.at(-1)!.decision).not.toBe("parked");
            } catch (error) {
                await rethrowWithDiagnostics(sessionId, error);
            }
        },
        300_000,
    );
});
