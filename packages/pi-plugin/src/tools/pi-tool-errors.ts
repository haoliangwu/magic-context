import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Pi's agent loop marks a thrown tool error as failed; it ignores isError on a returned result. */
export function throwReturnedToolErrors<T extends ToolDefinition>(tool: T): T {
	const execute: ToolDefinition["execute"] = tool.execute.bind(tool);
	return {
		...tool,
		async execute(...args: Parameters<ToolDefinition["execute"]>) {
			const result = await execute(...args);
			if ("isError" in result && result.isError) {
				throw new Error(
					result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
				);
			}
			return result;
		},
	} as T;
}
