import { isRecord } from "../shared/record-type-guard";

/** Routes streamed output only to the hidden attempt currently watching that child. */
export class HiddenModelActivity {
    private readonly watchers = new Map<string, () => void>();

    watch(sessionID: string, onOutput: () => void): () => void {
        this.watchers.set(sessionID, onOutput);
        return () => {
            if (this.watchers.get(sessionID) === onOutput) this.watchers.delete(sessionID);
        };
    }

    observe(event: unknown): void {
        if (!isRecord(event) || !isRecord(event.data)) return;
        const { sessionID, delta, text } = event.data;
        if (typeof sessionID !== "string") return;
        const streamed =
            ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta"].includes(
                String(event.type),
            ) &&
            typeof delta === "string" &&
            delta.length > 0;
        const ended =
            ["session.text.ended", "session.reasoning.ended"].includes(String(event.type)) &&
            typeof text === "string" &&
            text.length > 0;
        if (streamed || ended || event.type === "session.tool.input.started") {
            this.watchers.get(sessionID)?.();
        }
    }
}
