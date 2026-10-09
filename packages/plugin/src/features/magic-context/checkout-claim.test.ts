import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SubcError } from "@cortexkit/subc-client";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    CHECKOUT_CLAIM_REFUSAL_CODE,
    type CheckoutClaimConnection,
    type CheckoutClaimConnector,
    CheckoutClaimGate,
    type CheckoutClaimOutcome,
    CheckoutClaimRefusalError,
    isCheckoutClaimRefusalError,
    openCodeEventSessionId,
    readCheckoutClaim,
    subcCheckoutClaimConnector,
} from "./checkout-claim";
import {
    type FakeSubcDaemon,
    fakeFleetResponder,
    startFakeSubcDaemon,
} from "./checkout-claim-fake-subc.test-support";

type Step = { result: unknown } | { error: unknown } | { hang: true };

/** A connector that answers each query from a script and records what it was asked. */
function scripted(script: { agent?: Step; claim?: Step; connect?: "null" | Error }) {
    const asked: { agent: unknown[]; claim: unknown[]; closed: number; connects: number } = {
        agent: [],
        claim: [],
        closed: 0,
        connects: 0,
    };
    const answer = (step: Step | undefined): Promise<unknown> => {
        if (!step) return Promise.reject(new Error("unscripted query"));
        if ("hang" in step) return new Promise(() => undefined);
        if ("error" in step) return Promise.reject(step.error);
        return Promise.resolve(step.result);
    };
    const connector: CheckoutClaimConnector = async () => {
        asked.connects += 1;
        if (script.connect === "null") return null;
        if (script.connect instanceof Error) throw script.connect;
        const connection: CheckoutClaimConnection = {
            agentForHostSession: (params) => {
                asked.agent.push(params);
                return answer(script.agent);
            },
            claimRead: (params) => {
                asked.claim.push(params);
                return answer(script.claim);
            },
            close: () => {
                asked.closed += 1;
            },
        };
        return connection;
    };
    return { connector, asked };
}

const read = (connector: CheckoutClaimConnector, timeoutMs = 1_000) =>
    readCheckoutClaim({
        connector,
        harness: "opencode",
        sessionId: "ses_one",
        projectRoot: "/work/project",
        timeoutMs,
    });

const AGENT = { result: { agent_id: "agent_7" } };
const view = (fields: Record<string, unknown>) => ({ result: fields });

describe("readCheckoutClaim reply shapes", () => {
    it("admits a session with no agent (worker or unknown session) without reading a claim", async () => {
        const { connector, asked } = scripted({ agent: { result: { agent_id: null } } });
        expect(await read(connector)).toEqual({
            verdict: "admit",
            reason: "no_agent",
            agentId: null,
        });
        expect(asked.agent).toEqual([{ harness: "opencode", session: "ses_one" }]);
        expect(asked.claim).toEqual([]);
        expect(asked.closed).toBe(1);
    });

    it("admits an agent whose claim is held here", async () => {
        const { connector, asked } = scripted({
            agent: AGENT,
            claim: view({ epoch: 4, held_here: true, held_elsewhere: false, holder: "aa11" }),
        });
        expect(await read(connector)).toEqual({
            verdict: "admit",
            reason: "held_here",
            agentId: "agent_7",
            epoch: 4,
        });
        expect(asked.claim).toEqual([{ subject: "agent:agent_7" }]);
    });

    it("admits an unclaimed agent (epoch 0 reads held_elsewhere false)", async () => {
        const { connector } = scripted({
            agent: AGENT,
            claim: view({ absent: true, epoch: 0, held_here: false, held_elsewhere: false }),
        });
        expect(await read(connector)).toEqual({
            verdict: "admit",
            reason: "unclaimed",
            agentId: "agent_7",
            epoch: 0,
        });
    });

    // The one test that owns the held-elsewhere decision. Everything else that
    // needs a refusal stubs the outcome, so breaking the decision reddens only this.
    it("refuses an agent held elsewhere, from the flag or derived from an older reply, and names the holder", async () => {
        const flagged = scripted({
            agent: AGENT,
            claim: view({ epoch: 9, held_here: false, held_elsewhere: true, holder: "bb22cc33" }),
        });
        expect(await read(flagged.connector)).toEqual({
            verdict: "refuse",
            agentId: "agent_7",
            holder: "bb22cc33",
            epoch: 9,
        });
        const derived = scripted({
            agent: AGENT,
            claim: view({ epoch: 2, held_here: false, holder: "dd44" }),
        });
        expect(await read(derived.connector)).toEqual({
            verdict: "refuse",
            agentId: "agent_7",
            holder: "dd44",
            epoch: 2,
        });
    });

    it("admits an older reply for an agent that was never claimed", async () => {
        const neverClaimed = scripted({
            agent: AGENT,
            claim: view({ absent: true, epoch: 0, held_here: false }),
        });
        expect((await read(neverClaimed.connector)).verdict).toBe("admit");
    });

    it("admits with a warning when subc is not configured on this machine", async () => {
        const { connector } = scripted({ connect: "null" });
        expect(await read(connector)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "not_configured",
            stage: "connect",
        });
    });

    it("admits with a warning when the daemon is unreachable", async () => {
        const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
            code: "ECONNREFUSED",
        });
        const { connector } = scripted({ connect: refused });
        expect(await read(connector)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "error",
            stage: "connect",
            code: "ECONNREFUSED",
        });
    });

    for (const code of ["store_error", "invalid_request"]) {
        it(`admits with a warning when ALF answers ${code}`, async () => {
            const { connector, asked } = scripted({
                agent: { error: new SubcError(`alf ${code}`, code) },
            });
            expect(await read(connector)).toMatchObject({
                verdict: "admit_unchecked",
                reason: "error",
                stage: "agent",
                code,
            });
            expect(asked.claim).toEqual([]);
            expect(asked.closed).toBe(1);
        });
    }

    it("admits with a warning when engram cannot answer", async () => {
        const { connector } = scripted({
            agent: AGENT,
            claim: { error: new SubcError("engram unavailable", "unavailable") },
        });
        expect(await read(connector)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "error",
            stage: "claim",
            agentId: "agent_7",
            code: "unavailable",
        });
    });

    it("admits with a warning on replies this build cannot read", async () => {
        const badAgent = scripted({ agent: { result: { agent: "agent_7" } } });
        expect(await read(badAgent.connector)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "invalid_reply",
            stage: "agent",
        });
        const emptyAgent = scripted({ agent: { result: { agent_id: "" } } });
        expect((await read(emptyAgent.connector)).verdict).toBe("admit_unchecked");
        const badClaim = scripted({ agent: AGENT, claim: view({ held_here: false }) });
        expect(await read(badClaim.connector)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "invalid_reply",
            stage: "claim",
        });
        const oddFlag = scripted({
            agent: AGENT,
            claim: view({ epoch: 3, held_here: false, held_elsewhere: "yes" }),
        });
        expect((await read(oddFlag.connector)).verdict).toBe("admit_unchecked");
    });

    it("admits with a warning when a query outlives the latency budget, and closes the client", async () => {
        const hungAgent = scripted({ agent: { hang: true } });
        const started = Date.now();
        expect(await read(hungAgent.connector, 50)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "timeout",
            stage: "agent",
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(hungAgent.asked.closed).toBe(1);

        const hungClaim = scripted({ agent: AGENT, claim: { hang: true } });
        expect(await read(hungClaim.connector, 50)).toMatchObject({
            verdict: "admit_unchecked",
            reason: "timeout",
            stage: "claim",
            agentId: "agent_7",
        });
    });
});

describe("CheckoutClaimGate", () => {
    const REFUSE: CheckoutClaimOutcome = {
        verdict: "refuse",
        agentId: "agent_7",
        holder: "bb22cc33",
        epoch: 9,
    };
    const ADMIT: CheckoutClaimOutcome = {
        verdict: "admit",
        reason: "held_here",
        agentId: "agent_7",
        epoch: 1,
    };

    /** A gate whose checks return `outcome` and count themselves, on a manual clock. */
    function gateWith(outcome: CheckoutClaimOutcome) {
        let clock = 1_000_000;
        const asked = { reads: 0 };
        const gate = new CheckoutClaimGate({
            harness: "pi",
            connector: async () => null,
            read: async () => {
                asked.reads += 1;
                return outcome;
            },
            ttlMs: 60_000,
            refusalRecheckMs: 5_000,
            now: () => clock,
        });
        return {
            gate,
            asked,
            advance: (ms: number) => {
                clock += ms;
            },
        };
    }

    it("raises a refusal with the user-facing code and names the holding machine", async () => {
        const { gate } = gateWith(REFUSE);
        const error = await gate.enforce("ses_one", "/work/project").then(
            () => null,
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(CheckoutClaimRefusalError);
        expect(isCheckoutClaimRefusalError(error)).toBe(true);
        const refusal = error as CheckoutClaimRefusalError;
        expect(refusal.code).toBe(CHECKOUT_CLAIM_REFUSAL_CODE);
        expect(refusal.message).toContain("checked out on another machine");
        expect(refusal.message).toContain("holding machine: bb22cc33");
        expect(refusal.message).toContain("claim epoch 9");
        expect(refusal.message).toEndWith("(MC-C16)");
        expect(refusal).toMatchObject({ agentId: "agent_7", holder: "bb22cc33", epoch: 9 });
    });

    it("says so when the claim does not name the holder", async () => {
        const { gate } = gateWith({ ...REFUSE, holder: null, epoch: null });
        const refusal = await gate.refusal("ses_one", "/p");
        expect(refusal?.message).toContain("holding machine: not named by the claim");
    });

    it("admits every non-refusing outcome without throwing", async () => {
        for (const outcome of [
            { verdict: "admit", reason: "no_agent", agentId: null },
            ADMIT,
            { verdict: "admit", reason: "unclaimed", agentId: "agent_7", epoch: 0 },
            {
                verdict: "admit_unchecked",
                reason: "not_configured",
                stage: "connect",
                detail: "no subc connection file",
            },
            {
                verdict: "admit_unchecked",
                reason: "error",
                stage: "agent",
                code: "store_error",
                detail: "store",
            },
            { verdict: "admit_unchecked", reason: "timeout", stage: "claim", detail: "slow" },
        ] satisfies CheckoutClaimOutcome[]) {
            const { gate } = gateWith(outcome);
            expect(await gate.refusal("ses_one", "/work/project")).toBeNull();
            await gate.enforce("ses_one", "/work/project");
        }
    });

    it("checks once per TTL, then again after the TTL (a sleep past the TTL expires it too)", async () => {
        const { gate, asked, advance } = gateWith(ADMIT);
        await gate.check("ses_one", "/p");
        await gate.check("ses_one", "/p");
        advance(59_999);
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(1);
        advance(1);
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(2);
        // Another session has its own verdict.
        await gate.check("ses_two", "/p");
        expect(asked.reads).toBe(3);
    });

    it("caches an incomplete check for the TTL too, so an absent daemon costs no per-pass time", async () => {
        const { gate, asked } = gateWith({
            verdict: "admit_unchecked",
            reason: "not_configured",
            stage: "connect",
            detail: "no subc connection file",
        });
        await gate.check("ses_one", "/p");
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(1);
    });

    it("re-checks a refusal after the short refusal period so a moved-back agent is admitted promptly", async () => {
        const { gate, asked, advance } = gateWith(REFUSE);
        await gate.check("ses_one", "/p");
        advance(4_999);
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(1);
        advance(1);
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(2);
    });

    it("shares one in-flight check between concurrent passes of a session", async () => {
        const { gate, asked } = gateWith(ADMIT);
        await Promise.all([gate.check("ses_one", "/p"), gate.check("ses_one", "/p")]);
        expect(asked.reads).toBe(1);
    });

    it("forget() makes the next pass check again", async () => {
        const { gate, asked } = gateWith(ADMIT);
        await gate.check("ses_one", "/p");
        gate.forget("ses_one");
        await gate.check("ses_one", "/p");
        expect(asked.reads).toBe(2);
    });

    it("hands each check its harness, session, project root and latency budget", async () => {
        const seen: unknown[] = [];
        const gate = new CheckoutClaimGate({
            harness: "opencode",
            connector: async () => null,
            timeoutMs: 321,
            read: async (args) => {
                seen.push({
                    harness: args.harness,
                    sessionId: args.sessionId,
                    projectRoot: args.projectRoot,
                    timeoutMs: args.timeoutMs,
                });
                return ADMIT;
            },
        });
        await gate.check("ses_one", "/work/project");
        expect(seen).toEqual([
            {
                harness: "opencode",
                sessionId: "ses_one",
                projectRoot: "/work/project",
                timeoutMs: 321,
            },
        ]);
    });
});

describe("subcCheckoutClaimConnector over the subc wire", () => {
    let daemon: FakeSubcDaemon | undefined;
    let cleanup: (() => void) | undefined;

    afterEach(async () => {
        await daemon?.close();
        daemon = undefined;
        cleanup?.();
        cleanup = undefined;
    });

    async function fleet(fleetState: Parameters<typeof fakeFleetResponder>[0]) {
        const temp = createTestTempDir("checkout-claim-wire-");
        cleanup = temp.cleanup;
        daemon = await startFakeSubcDaemon(
            join(temp.dir, "subc-connection.json"),
            fakeFleetResponder(fleetState),
        );
        return new CheckoutClaimGate({
            harness: "opencode",
            connector: subcCheckoutClaimConnector(() => (daemon as FakeSubcDaemon).connectionFile),
        });
    }

    it("asks ALF and engram on their production routes as a direct caller", async () => {
        const gate = await fleet({
            agents: { ses_moved: "agent_moved" },
            claims: {
                agent_moved: {
                    epoch: 5,
                    held_here: true,
                    held_elsewhere: false,
                    holder: "c0ffee00c0ffee00c0ffee00c0ffee00",
                },
            },
        });
        expect(await gate.check("ses_moved", "/work/project")).toEqual({
            verdict: "admit",
            reason: "held_here",
            agentId: "agent_moved",
            epoch: 5,
        });
        const wire = daemon as FakeSubcDaemon;
        expect(wire.routeOpens.map((route) => route.target)).toEqual([
            { kind: "management_surface", module_id: "prefrontal-core" },
            { kind: "internal_service", module_id: "engram", service_id: "agent-sync" },
        ]);
        for (const route of wire.routeOpens) {
            expect(route.consumerIdentity).toBeUndefined();
            expect(route.identity).toEqual({
                project_root: "/work/project",
                harness: "opencode",
                session: "ses_moved",
            });
        }
        expect(wire.calls.map(({ method, params }) => ({ method, params }))).toEqual([
            {
                method: "agent.for_host_session",
                params: { harness: "opencode", session: "ses_moved" },
            },
            { method: "claim.read", params: { subject: "agent:agent_moved" } },
        ]);
    });

    it("admits an unknown session without asking engram", async () => {
        const gate = await fleet({ agents: {}, claims: {} });
        expect(await gate.check("ses_unknown", "/p")).toEqual({
            verdict: "admit",
            reason: "no_agent",
            agentId: null,
        });
        expect((daemon as FakeSubcDaemon).calls.map((call) => call.method)).toEqual([
            "agent.for_host_session",
        ]);
    });

    it("carries a module's Error frame code through to the warning outcome", async () => {
        const temp = createTestTempDir("checkout-claim-wire-");
        cleanup = temp.cleanup;
        daemon = await startFakeSubcDaemon(join(temp.dir, "subc-connection.json"), () => ({
            error: { code: "store_error", message: "alf store unavailable" },
        }));
        const gate = new CheckoutClaimGate({
            harness: "pi",
            connector: subcCheckoutClaimConnector(() => (daemon as FakeSubcDaemon).connectionFile),
        });
        expect(await gate.check("ses_x", "/p")).toMatchObject({
            verdict: "admit_unchecked",
            reason: "error",
            stage: "agent",
            code: "store_error",
        });
    });

    it("admits with a warning when no connection file exists", async () => {
        const temp = createTestTempDir("checkout-claim-wire-");
        cleanup = temp.cleanup;
        const gate = new CheckoutClaimGate({
            harness: "pi",
            connector: subcCheckoutClaimConnector(() => join(temp.dir, "absent.json")),
        });
        expect(await gate.check("ses_x", "/p")).toMatchObject({
            verdict: "admit_unchecked",
            reason: "not_configured",
        });
    });
});

describe("openCodeEventSessionId", () => {
    it("finds the session in each OpenCode 1 event shape", () => {
        expect(
            openCodeEventSessionId({
                type: "session.created",
                properties: { info: { id: "ses_a", parentID: "" } },
            }),
        ).toBe("ses_a");
        expect(
            openCodeEventSessionId({
                type: "message.updated",
                properties: { info: { id: "msg_1", sessionID: "ses_b" } },
            }),
        ).toBe("ses_b");
        expect(
            openCodeEventSessionId({
                type: "message.part.updated",
                properties: { part: { id: "prt_1", sessionID: "ses_c" } },
            }),
        ).toBe("ses_c");
        expect(
            openCodeEventSessionId({ type: "session.idle", properties: { sessionID: "ses_d" } }),
        ).toBe("ses_d");
        // A message's own id is not a session id.
        expect(
            openCodeEventSessionId({
                type: "message.removed",
                properties: { info: { id: "msg_2" } },
            }),
        ).toBeUndefined();
        expect(
            openCodeEventSessionId({ type: "server.connected", properties: {} }),
        ).toBeUndefined();
    });
});
