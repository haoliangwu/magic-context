import { describe, expect, it } from "bun:test";
import { CheckoutClaimRefusalError } from "@magic-context/core/features/magic-context/checkout-claim";
import { gatePiEventsByCheckoutClaim } from "./checkout-claim-pi";

type Handler = (payload: unknown, ctx: unknown) => unknown;

const REFUSAL = new CheckoutClaimRefusalError({
	agentId: "agent_7",
	holder: "bb22cc33",
	epoch: 9,
});

function fakePi() {
	const handlers = new Map<string, Handler>();
	const pi = {
		marker: "host-api",
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		appendEntry(this: { marker: string }) {
			return this.marker;
		},
	};
	return { pi, handlers };
}

const ctxFor = (sessionId: string) => ({
	cwd: "/work/project",
	sessionManager: { getSessionId: () => sessionId },
});

describe("gatePiEventsByCheckoutClaim", () => {
	function setup(refused: Set<string>, active = true) {
		const { pi, handlers } = fakePi();
		const asked: string[] = [];
		const gated = gatePiEventsByCheckoutClaim(pi as never, () =>
			active
				? {
						refusal: async (sessionId: string, projectRoot: string) => {
							asked.push(`${sessionId}@${projectRoot}`);
							return refused.has(sessionId) ? REFUSAL : null;
						},
					}
				: undefined,
		);
		const ran: string[] = [];
		for (const event of [
			"before_agent_start",
			"message_end",
			"agent_end",
			"context",
			"session_start",
			"session_shutdown",
			"session_before_switch",
		]) {
			(gated.on as unknown as (event: string, handler: Handler) => void)(
				event,
				(_payload, ctx) => {
					ran.push(
						`${event}:${(ctx as ReturnType<typeof ctxFor>).sessionManager.getSessionId()}`,
					);
					return { handled: event };
				},
			);
		}
		const fire = (event: string, sessionId: string) =>
			Promise.resolve(
				(handlers.get(event) as Handler)({ type: event }, ctxFor(sessionId)),
			);
		return { gated, ran, asked, fire };
	}

	it("skips gated handlers for a held-elsewhere session and runs the rest", async () => {
		const { ran, asked, fire } = setup(new Set(["moved"]));
		expect(await fire("before_agent_start", "moved")).toBeUndefined();
		expect(await fire("message_end", "moved")).toBeUndefined();
		expect(await fire("agent_end", "moved")).toBeUndefined();
		for (const event of [
			"context",
			"session_start",
			"session_shutdown",
			"session_before_switch",
		]) {
			expect(await fire(event, "moved")).toEqual({ handled: event });
		}
		expect(ran).toEqual([
			"context:moved",
			"session_start:moved",
			"session_shutdown:moved",
			"session_before_switch:moved",
		]);
		expect(asked).toEqual([
			"moved@/work/project",
			"moved@/work/project",
			"moved@/work/project",
		]);
	});

	it("runs gated handlers, with their results, for an admitted session", async () => {
		const { ran, fire } = setup(new Set(["moved"]));
		expect(await fire("before_agent_start", "here")).toEqual({
			handled: "before_agent_start",
		});
		expect(ran).toEqual(["before_agent_start:here"]);
	});

	it("passes everything through while the gate is inactive", async () => {
		const { ran, asked, fire } = setup(new Set(["moved"]), false);
		expect(await fire("before_agent_start", "moved")).toEqual({
			handled: "before_agent_start",
		});
		expect(ran).toEqual(["before_agent_start:moved"]);
		expect(asked).toEqual([]);
	});

	it("forwards the rest of the API bound to the host object", () => {
		const { gated } = setup(new Set());
		expect(
			(gated as unknown as { appendEntry: () => string }).appendEntry(),
		).toBe("host-api");
	});
});
