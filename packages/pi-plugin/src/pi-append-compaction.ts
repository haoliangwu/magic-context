import { log } from "@magic-context/core/shared/logger";
import { resolvePiHarnessKind } from "./pi-harness-kind";

export type PiAppendCompaction = (
	summary: string,
	firstKeptEntryId: string,
	tokensBefore: number,
	details?: unknown,
	fromHook?: boolean,
) => string | undefined;

let loggedIncompatibleHost = false;
const failedWrites = new WeakMap<object, Error>();

/** Bind the host once at the API boundary; all callers use Pi's argument order. */
export function adaptPiAppendCompaction(
	sessionManager: unknown,
): PiAppendCompaction | undefined {
	if (!sessionManager || typeof sessionManager !== "object") return undefined;
	const host = sessionManager as {
		appendCompaction?: (...args: unknown[]) => unknown;
		getEntry?: (id: string) => unknown;
	};
	const append = host.appendCompaction;
	if (typeof append !== "function") return undefined;
	// Do not let a later drain mistake a failed read-back for an already-current
	// boundary just because the corrupt entry happened to retain the right id.
	if (failedWrites.has(host)) return undefined;
	const harness = resolvePiHarnessKind();
	// Optional TS parameters count on Pi (5, or 6 with usage) and OMP 17 (7).
	// OMP 18's default options parameter stops Function.length at 4, not 5.
	if (
		(harness === "omp"
			? append.length !== 4 && append.length !== 7
			: append.length !== 5 && append.length !== 6) ||
		typeof host.getEntry !== "function"
	) {
		if (!loggedIncompatibleHost) {
			loggedIncompatibleHost = true;
			log(
				`ERROR: compaction marker disabled: incompatible host binding harness=${harness} arity=${append.length} getEntry=${typeof host.getEntry}; leaving marker pending`,
			);
		}
		return undefined;
	}
	const getEntry = host.getEntry.bind(host);
	return (summary, firstKeptEntryId, tokensBefore, details, fromHook) => {
		const previousFailure = failedWrites.get(host);
		if (previousFailure) throw previousFailure;
		let id: unknown;
		if (harness === "pi") {
			id = append.call(
				host,
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromHook,
			);
		} else if (append.length === 7) {
			id = append.call(
				host,
				summary,
				undefined,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromHook,
			);
		} else {
			id = append.call(
				host,
				summary,
				undefined,
				firstKeptEntryId,
				tokensBefore,
				{ details, fromExtension: fromHook },
			);
		}
		try {
			const entry = (
				typeof id === "string" && id.length > 0 ? getEntry(id) : undefined
			) as
				| {
						type?: unknown;
						firstKeptEntryId?: unknown;
						details?: { source?: unknown };
				  }
				| undefined;
			if (
				entry?.type !== "compaction" ||
				entry.firstKeptEntryId !== firstKeptEntryId ||
				entry.details?.source !== "magic-context"
			) {
				throw new Error("Compaction marker read-back mismatch");
			}
		} catch {
			const error = new Error(
				"Compaction marker read-back failed; writes disabled for this session manager until restart",
			);
			// Rebinding on every drain must not retry a write that already persisted
			// a corrupt entry. Weak keys bound the latch to the host manager's life.
			failedWrites.set(host, error);
			log(
				`ERROR: compaction marker read-back failed harness=${harness} compactionId=${typeof id === "string" ? id : "<missing>"} expectedFirstKept=${firstKeptEntryId}; further writes disabled for this session manager until restart; leaving marker pending`,
			);
			throw error;
		}
		return id as string;
	};
}
