import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import type { PiHistorianOptions } from "./context-handler";

/** Build the shared historian settings passed to Pi's manual commands. */
export function buildPiHistorianCommandOptions(
	historian: PiHistorianOptions | undefined,
	config: MagicContextConfig,
) {
	return {
		historianModel: historian?.model,
		historianChunkTokens:
			historian?.historianChunkTokens ??
			deriveHistorianChunkTokens(
				resolveHistorianContextLimit(historian?.model),
			),
		historianFallbacks: historian?.fallbackModels,
		historianTimeoutMs: historian?.timeoutMs ?? config.historian_timeout_ms,
		historianMaxOutputTokens: historian?.maxOutputTokens,
		historianThinkingLevel: historian?.thinkingLevel,
	};
}
