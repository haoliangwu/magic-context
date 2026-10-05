import type { ToolDefinition } from "@opencode-ai/plugin";
import { getOrCreateSessionMeta } from "../features/magic-context/storage";
import type { Database } from "../shared/sqlite";

const PRIMARY_ONLY_TOOLS = new Set(["ctx_memory", "ctx_note"]);

/** OC1's task tool turns primary_tools into child-session permission denies. */
export function primaryOnlyToolIds(existing: readonly string[] = []): string[] {
    return [...new Set([...existing, ...PRIMARY_ONLY_TOOLS])];
}

/** Use the transform's persisted mode, not an agent name that a caller can change. */
export function subagentToolRefusal(
    db: Database,
    toolId: string,
    sessionId: string,
    isInternalChild: (sessionId: string) => boolean = () => false,
): string | undefined {
    if (
        PRIMARY_ONLY_TOOLS.has(toolId) &&
        !isInternalChild(sessionId) &&
        getOrCreateSessionMeta(db, sessionId).isSubagent
    ) {
        return `Error: ${toolId} is unavailable in subagent sessions. Use the primary session instead.`;
    }
    return undefined;
}

/** Protect reduced sessions not created through task, without changing definitions. */
export function guardSubagentTools(
    tools: Record<string, ToolDefinition>,
    db: Database,
    isInternalChild?: (sessionId: string) => boolean,
): Record<string, ToolDefinition> {
    return Object.fromEntries(
        Object.entries(tools).map(([id, definition]) => [
            id,
            PRIMARY_ONLY_TOOLS.has(id)
                ? {
                      ...definition,
                      async execute(args, context) {
                          const refusal = subagentToolRefusal(
                              db,
                              id,
                              context.sessionID,
                              isInternalChild,
                          );
                          return refusal ?? definition.execute(args, context);
                      },
                  }
                : definition,
        ]),
    );
}

/** OC2 hands each request its own tool map; never mutate global registrations. */
export function hideSubagentTools(
    draft: { sessionID: string; tools: Record<string, unknown> },
    db: Database,
): void {
    if (!getOrCreateSessionMeta(db, draft.sessionID).isSubagent) return;
    for (const id of PRIMARY_ONLY_TOOLS) delete draft.tools[id];
}
