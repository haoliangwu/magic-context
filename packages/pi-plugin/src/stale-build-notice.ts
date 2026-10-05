import { registerStalePluginBuildHost } from "@magic-context/core/shared/stale-plugin-build";

interface PiNoticeContext {
	hasUI?: boolean;
	ui?: { notify?: (message: string, level: "warning") => unknown };
}

export function bindStaleBuildNotice(
	ctx: PiNoticeContext,
	moduleUrl: string,
): void {
	registerStalePluginBuildHost({
		moduleUrl,
		harness: "pi",
		...(ctx.hasUI && ctx.ui?.notify
			? {
					notify: (message: string) => ctx.ui?.notify?.(message, "warning"),
				}
			: {}),
	});
}
