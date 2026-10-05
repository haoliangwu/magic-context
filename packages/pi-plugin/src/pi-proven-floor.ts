/**
 * The model a Pi session's proven input floor was proven on.
 *
 * `session_meta.observed_safe_input_tokens` is the largest prompt a provider
 * accepted in the session. Magic Context lifts the usable context limit to it
 * when Pi's configured window is smaller. That proof is only about the model
 * (provider route and model id) that served the request: a 786K prompt
 * accepted by a 1M-window model says nothing about a model with a 500K
 * window. So the floor is recorded together with that model, and applied only
 * while the session runs on it.
 *
 * The model is kept in the JSON object in `session_meta.deferred_execute_state`
 * (a namespaced per-session state column that the decision calibration also
 * uses), under its own key, with the token count it was recorded for. A floor
 * whose column value no longer equals the recorded count was written without
 * a model (by a release before this check, or by a path that does not record
 * one), so nothing says which model proved it: it is dropped on first use.
 */

import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";

const FLOOR_STATE_KEY = "piProvenInputFloor";

// `session|proven model|current model` triples already logged as not applied.
const mismatchLogged = new Set<string>();

export interface PiProvenFloorRecord {
	/** `provider/id` exactly as Pi reports the model that served the request. */
	modelKey: string;
	tokens: number;
}

/** `provider/id` for a Pi model, or undefined when either part is missing. */
export function piProvenFloorModelKey(
	model: { provider?: unknown; id?: unknown } | null | undefined,
): string | undefined {
	if (!model) return undefined;
	if (typeof model.provider !== "string" || model.provider.length === 0)
		return undefined;
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return `${model.provider}/${model.id}`;
}

function readFloorRow(
	db: ContextDatabase,
	sessionId: string,
): { observed: number; state: unknown } {
	try {
		const row = db
			.prepare(
				"SELECT observed_safe_input_tokens, deferred_execute_state FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId) as
			| {
					observed_safe_input_tokens?: unknown;
					deferred_execute_state?: unknown;
			  }
			| undefined;
		const observed = row?.observed_safe_input_tokens;
		return {
			observed:
				typeof observed === "number" && Number.isFinite(observed)
					? observed
					: 0,
			state: row?.deferred_execute_state,
		};
	} catch {
		return { observed: 0, state: undefined };
	}
}

function parseFloorRecord(raw: unknown): PiProvenFloorRecord | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	try {
		const root = JSON.parse(raw) as Record<string, unknown> | null;
		const value = root?.[FLOOR_STATE_KEY] as
			| { modelKey?: unknown; tokens?: unknown }
			| undefined;
		if (
			value &&
			typeof value.modelKey === "string" &&
			value.modelKey.length > 0 &&
			typeof value.tokens === "number" &&
			Number.isFinite(value.tokens)
		) {
			return { modelKey: value.modelKey, tokens: value.tokens };
		}
	} catch {
		// An unreadable state document records no model.
	}
	return undefined;
}

export function readPiProvenFloorRecord(
	db: ContextDatabase,
	sessionId: string,
): PiProvenFloorRecord | undefined {
	return parseFloorRecord(readFloorRow(db, sessionId).state);
}

/**
 * Record the model a floor was proven on. Merged into the state object with
 * json_set so the other keys in it are kept.
 */
export function recordPiProvenFloorModel(
	db: ContextDatabase,
	sessionId: string,
	modelKey: string,
	tokens: number,
): void {
	getOrCreateSessionMeta(db, sessionId);
	db.prepare(
		`UPDATE session_meta
		    SET deferred_execute_state = json_set(
		          CASE WHEN json_valid(deferred_execute_state)
		                AND json_type(deferred_execute_state) = 'object'
		               THEN deferred_execute_state ELSE '{}' END,
		          '$.${FLOOR_STATE_KEY}', json(?))
		  WHERE session_id = ?`,
	).run(JSON.stringify({ modelKey, tokens }), sessionId);
}

/**
 * The persisted floor to apply for `modelKey`, or 0. Reads the stored floor
 * itself, so a caller holding an older copy of the session row cannot apply
 * or re-drop a floor that has since changed.
 *
 * - A floor with no recorded model is cleared from the session and not used.
 * - A floor proven on another model is not used. It stays stored, so it
 *   applies again if the session returns to that model, until a request on
 *   the current model records a floor of its own.
 * - With no current model key nothing is known to match, so no floor applies.
 */
export function resolvePiProvenInputFloor(args: {
	db: ContextDatabase;
	sessionId: string;
	modelKey: string | undefined;
}): number {
	const row = readFloorRow(args.db, args.sessionId);
	const observed = row.observed;
	if (observed <= 0) return 0;
	const record = parseFloorRecord(row.state);
	if (!record || record.tokens !== observed) {
		sessionLog(
			args.sessionId,
			`proven input floor ${observed} has no recorded model; dropped instead of applied to ${args.modelKey ?? "the current model"}`,
		);
		updateSessionMeta(args.db, args.sessionId, {
			observedSafeInputTokens: 0,
			cacheAlertSent: false,
		});
		return 0;
	}
	if (args.modelKey === undefined || record.modelKey !== args.modelKey) {
		const logKey = `${args.sessionId}|${record.modelKey}|${args.modelKey ?? ""}`;
		if (!mismatchLogged.has(logKey)) {
			mismatchLogged.add(logKey);
			sessionLog(
				args.sessionId,
				`proven input floor ${observed} was proven on ${record.modelKey}; not applied to ${args.modelKey ?? "an unknown model"}`,
			);
		}
		return 0;
	}
	return observed;
}
