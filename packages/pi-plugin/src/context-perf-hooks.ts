export interface PiTransformTimingSample {
	/** Per-pass counts for number-only publication, skipped evidence, or optional write failures. */
	publication?: {
		status: "numbers_only" | "skipped" | "commit_failed" | "mirror_failed";
		reason: string;
		count: number;
	};
	sessionId: string;
	stage: string;
	elapsedMs: number;
	extra?: string;
}

export type PiTransformTimingObserver = (
	sample: PiTransformTimingSample,
) => void;

let timingObserver: PiTransformTimingObserver | undefined;

/**
 * Installs a process-local timing observer for the isolated transform harness.
 * Production has no observer, so recording a stage remains a single undefined check.
 */
export function setPiTransformTimingObserver(
	observer: PiTransformTimingObserver | undefined,
): () => void {
	const previous = timingObserver;
	timingObserver = observer;
	return () => {
		timingObserver = previous;
	};
}

export function hasPiTransformTimingObserver(): boolean {
	return timingObserver !== undefined;
}

export function recordPiTransformTiming(sample: PiTransformTimingSample): void {
	timingObserver?.(sample);
}
