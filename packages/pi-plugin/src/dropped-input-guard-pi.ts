import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createDroppedInputGuard } from "@magic-context/core/hooks/magic-context/dropped-input-guard";

export interface PiDroppedInputGuardOptions {
	/** The live schema of a tool by name, so the refusal can list its real parameters. */
	parametersFor?: (toolName: string) => unknown;
}

export function createPiDroppedInputGuard(
	options: PiDroppedInputGuardOptions = {},
): (
	event: ToolCallEvent,
	ctx?: Pick<ExtensionContext, "sessionManager">,
) => ToolCallEventResult | undefined {
	const guard = createDroppedInputGuard({
		parametersFor: options.parametersFor,
	});
	return (event, ctx) => {
		let sessionID: string | undefined;
		try {
			sessionID = ctx?.sessionManager?.getSessionId?.();
		} catch {
			sessionID = undefined;
		}
		const reason = guard.check({
			sessionID,
			toolName: event.toolName,
			input: event.input,
		});
		if (reason === undefined) return undefined;
		return { block: true, reason };
	};
}

export function registerPiDroppedInputGuard(pi: ExtensionAPI): void {
	pi.on(
		"tool_call",
		createPiDroppedInputGuard({
			parametersFor: (toolName) =>
				pi.getAllTools?.().find((tool) => tool.name === toolName)?.parameters,
		}),
	);
}
