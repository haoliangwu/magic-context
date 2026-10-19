/**
 * OMP 18.10.3 has no context-purpose field. Its request dump calls these two
 * methods synchronously through the extension runner. Require both frames
 * from the host's session file; an unknown caller is still a guarded turn.
 */
export function isOmpDumpContextStack(stack: string | undefined): boolean {
	if (!stack) return false;
	const frames = stack.replaceAll("\\", "/").split("\n");
	const hostFrame = (method: string) =>
		frames.some((frame) =>
			new RegExp(
				`^\\s*at (?:async )?(?:AgentSession\\.)?${method} \\(.*?/@oh-my-pi/pi-coding-agent/src/session/agent-session\\.ts:\\d+:\\d+\\)$`,
			).test(frame),
		);
	return (
		hostFrame("#formatLlmRequestJson") && hostFrame("dumpLlmRequestToTmpDir")
	);
}

export function isOmpDumpContext(): boolean {
	// The default ten-frame stack stops inside the runner, before the caller.
	// Capture synchronously and restore the global limit before yielding.
	const limit = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = Math.max(limit ?? 10, 64);
		return isOmpDumpContextStack(new Error().stack);
	} finally {
		Error.stackTraceLimit = limit;
	}
}
