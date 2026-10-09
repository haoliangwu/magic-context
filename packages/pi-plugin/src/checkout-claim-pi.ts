import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckoutClaimGate } from "@magic-context/core/features/magic-context/checkout-claim";

/**
 * Events whose handlers run whatever the checkout claim says:
 *   - `context` refuses the turn itself, loudly (see context-handler.ts);
 *   - `session_start` checks the claim itself and tells the user;
 *   - `session_shutdown` and `session_before_switch` release this process's
 *     in-memory resources, which must happen for every session.
 */
const UNGATED_EVENTS = new Set([
	"context",
	"session_start",
	"session_shutdown",
	"session_before_switch",
]);

function sessionIdOf(ctx: unknown): string | undefined {
	const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } })
		?.sessionManager;
	if (typeof manager?.getSessionId !== "function") return undefined;
	try {
		const id = manager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Wrap Pi's extension API so every Magic Context event handler registered
 * through it skips a session whose agent another machine holds. Before the
 * turn reaches the `context` event (where it is refused), Pi already runs
 * `before_agent_start`, whose handlers write the session's system-prompt
 * state; after the refusal it still runs `message_end` and `agent_end`. None
 * of those may write for such a session.
 *
 * Pi awaits every handler, so the wrapper may be async. The verdict is cached
 * per session, so after session start this costs a map lookup.
 */
export function gatePiEventsByCheckoutClaim(
	pi: ExtensionAPI,
	gate: () => Pick<CheckoutClaimGate, "refusal"> | undefined,
): ExtensionAPI {
	const on = (
		event: string,
		handler: (payload: unknown, ctx: unknown) => unknown,
	): unknown => {
		const register = pi.on as unknown as (
			event: string,
			handler: (payload: unknown, ctx: unknown) => unknown,
		) => unknown;
		if (UNGATED_EVENTS.has(event)) return register.call(pi, event, handler);
		return register.call(pi, event, async (payload: unknown, ctx: unknown) => {
			const active = gate();
			const sessionId = active ? sessionIdOf(ctx) : undefined;
			if (active && sessionId) {
				const cwd = (ctx as { cwd?: unknown })?.cwd;
				const refusal = await active.refusal(
					sessionId,
					typeof cwd === "string" ? cwd : process.cwd(),
				);
				if (refusal) return undefined;
			}
			return handler(payload, ctx);
		});
	};
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on") return on;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
