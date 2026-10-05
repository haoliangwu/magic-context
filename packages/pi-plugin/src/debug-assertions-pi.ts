/** Expensive diagnostic walks are opt-in, even in unbundled development hosts. */
export function runPiDebugAssertion(assert: (() => void) | undefined): void {
	if (process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS === "1") assert?.();
}
