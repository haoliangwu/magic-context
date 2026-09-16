// Structural host boundary: importing the GA context types also augments global
// Error with Effect's readonly ignore flag, breaking the co-published v1 types.
// These are only the mutable request and promise-domain fields this adapter uses.
export interface V2Message {
    id?: string;
    role: string;
    content: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
export interface SessionContext {
    sessionID: string;
    model: { providerID: string; id: string; variant?: string };
    agent: string;
    messages: V2Message[];
    system: Array<Record<string, unknown>>;
    tools: Record<string, { description: string; input: unknown }>;
    options: Record<string, unknown>;
    result?: { summary: string };
}
export interface V2Context {
    location: { directory: string };
    event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> };
    catalog: {
        model: {
            list(input: { location: { directory: string } }): Promise<{
                data: Array<{ id: string; providerID: string; limit: { context: number } }>;
            }>;
        };
    };
    storage: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<void>;
    };
    tool: {
        hook(
            name: "execute.before" | "execute.after",
            callback: (draft: {
                tool: string;
                sessionID: string;
                input: unknown;
                status?: string;
                result?: { content?: unknown };
            }) => void | Promise<void>,
        ): Promise<unknown>;
    };
    session: {
        generate?: (
            input: { sessionID: string; prompt: string },
            options?: { signal?: AbortSignal },
        ) => Promise<{ text: string }>;
        synthetic(input: {
            sessionID: string;
            id: string;
            text: string;
            delivery: "steer";
        }): Promise<unknown>;
        hook(
            name: "context" | "compaction" | "generate",
            callback: (draft: SessionContext) => Promise<void>,
        ): Promise<unknown>;
        interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
    };
}
