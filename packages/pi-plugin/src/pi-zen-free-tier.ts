import { canonicalModelIdentity } from "@magic-context/core/shared/harness-provider-map";
import type { SubagentRunResult } from "@magic-context/core/shared/subagent-runner";
import type { PiHarnessKind } from "./pi-harness-kind";

export const ZEN_FREE_TIER_FAILURE = "opencode_zen_free_tier";

export function isZenModel(model: string | undefined): boolean {
	return (
		model !== undefined && canonicalModelIdentity(model).startsWith("opencode/")
	);
}

export function isZenFreeTierRefusal(text: string): boolean {
	return (
		/\bFreeTierError\b/.test(text) ||
		(/\b403\b/.test(text) &&
			/OpenCode's free tier can only be used from within OpenCode/i.test(text))
	);
}

export function zenFreeTierMessage(
	agent: string,
	harness: PiHarnessKind,
): string {
	const task = agent.includes("historian") ? "historian" : "dreamer";
	const host = harness === "omp" ? "Oh My Pi" : "Pi";
	return `${ZEN_FREE_TIER_FAILURE}: OpenCode Zen free models only run inside OpenCode; choose another ${task} model for ${host} (FreeTierError).`;
}

/** Preserve retry categories, but never retain the gateway's raw body in diagnostics. */
export function classifyZenFreeTierFailure(
	result: SubagentRunResult,
	model: string | undefined,
	agent: string,
	harness: PiHarnessKind,
): SubagentRunResult {
	if (result.ok || !isZenModel(model)) return result;
	const stderr =
		typeof result.meta?.stderr === "string" ? result.meta.stderr : "";
	if (!isZenFreeTierRefusal(result.error) && !isZenFreeTierRefusal(stderr))
		return result;
	return {
		...result,
		error: zenFreeTierMessage(agent, harness),
		meta: {
			failureClass: ZEN_FREE_TIER_FAILURE,
			errorClass: "FreeTierError",
			...(typeof result.meta?.exitCode === "number"
				? { exitCode: result.meta.exitCode }
				: {}),
			...(typeof result.meta?.sawProtocolOutput === "boolean"
				? { sawProtocolOutput: result.meta.sawProtocolOutput }
				: {}),
		},
	};
}
