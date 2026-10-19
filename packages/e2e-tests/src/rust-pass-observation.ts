import { watch } from "node:fs";
import { dirname } from "node:path";

interface RustPassObservationLine {
	inputCount: number;
	raw: string;
}

type HostMessage = {
	info?: { id?: string; role?: string };
	parts?: Array<{ type?: string; text?: string }>;
};

export interface RustPassTurn {
	turnId: string;
	inputCount: number;
	prompt: string;
}

/**
 * Join a full, uncompacted host branch to submitted user turns. Rust's `in`
 * diagnostic counts the raw prefix ending at that user message, before the
 * response is added. Host message ids establish the prefix order; the submitted
 * prompt identifies the turn, so a stale total log count cannot stand in for it.
 */
export function rustPassTurnsForFullBranch(
	messages: readonly HostMessage[],
	promptPrefixes: readonly string[],
): RustPassTurn[] {
	const ordered = messages
		.map((message) => {
			const id = message.info?.id;
			if (!id)
				throw new Error(
					"Cannot correlate Rust passes: a host message has no id",
				);
			return { ...message, id };
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	return promptPrefixes.map((prompt) => {
		const matches = ordered.flatMap((message, index) =>
			message.info?.role === "user" &&
			message.parts?.some(
				(part) => part.type === "text" && part.text?.startsWith(prompt),
			)
				? [{ turnId: message.id, inputCount: index + 1, prompt }]
				: [],
		);
		const match = matches[0];
		if (matches.length !== 1 || !match) {
			throw new Error(
				`Cannot correlate Rust turn ${prompt}: found ${matches.length} host messages`,
			);
		}
		return match;
	});
}

export function observeRustPassTurns(
	turns: readonly RustPassTurn[],
	passes: readonly RustPassObservationLine[],
) {
	const byPrefix = new Map(turns.map((turn) => [turn.inputCount, turn]));
	if (
		byPrefix.size !== turns.length ||
		new Set(turns.map((turn) => turn.turnId)).size !== turns.length
	) {
		throw new Error(
			"Cannot correlate Rust passes: turn identities or raw prefixes are ambiguous",
		);
	}
	const entries = turns.map((turn) => ({
		...turn,
		observed: passes.filter((pass) => pass.inputCount === turn.inputCount),
	}));
	const unexpected = passes.filter((pass) => !byPrefix.has(pass.inputCount));
	return {
		complete:
			unexpected.length === 0 &&
			entries.every((entry) => entry.observed.length === 1),
		entries,
		unexpected,
	};
}

/** Wait for log publication, not elapsed time; reject with the observed turn join on timeout. */
export async function waitForRustPassTurns<T extends RustPassObservationLine>(
	logPath: string,
	turns: readonly RustPassTurn[],
	readPasses: () => T[],
	timeoutMs = 5_000,
): Promise<T[]> {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: Error, passes?: T[]) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error);
			else if (passes) resolve(passes);
			else
				reject(
					new Error("Rust pass publication finished without an observation"),
				);
		};
		const check = () => {
			try {
				const passes = readPasses();
				if (observeRustPassTurns(turns, passes).complete)
					finish(undefined, passes);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const watcher = watch(dirname(logPath), check);
		watcher.on("error", (error) => finish(error));
		const timer = setTimeout(() => {
			try {
				const seen = observeRustPassTurns(turns, readPasses());
				finish(
					new Error(
						`Rust pass publication timed out after ${timeoutMs}ms: ${JSON.stringify(seen)}`,
					),
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		}, timeoutMs);
		check();
	});
}
