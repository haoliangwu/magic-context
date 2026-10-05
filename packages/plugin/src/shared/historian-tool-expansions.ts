import defaults from "./historian-tool-defaults.json";
import { renderToolTemplate, type ToolExpansionMap } from "./historian-tool-template";

export { defaults as DEFAULT_TOOL_EXPANSIONS };
export function expandToolPart(part: unknown, overrides?: ToolExpansionMap): string | null {
    if (!part || typeof part !== "object") return null;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool" || typeof p.tool !== "string") return null;
    const template =
        overrides && Object.hasOwn(overrides, p.tool)
            ? overrides[p.tool]
            : Object.hasOwn(defaults, p.tool)
              ? defaults[p.tool as keyof typeof defaults]
              : undefined;
    if (typeof template !== "string") return null;
    const state = p.state as Record<string, unknown> | undefined;
    return renderToolTemplate(template, state?.input, state?.output ?? state?.error);
}
