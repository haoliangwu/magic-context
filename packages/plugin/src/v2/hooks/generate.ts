import { sessionLog } from "../../shared/logger";
import { clonePreservingInstances } from "./payload";
import type { SessionContext, V2Message } from "./types";

interface GenerateReplayAnchor {
    id: string;
    tail: V2Message[];
}

/** Preserve the host boundary before Magic Context tags or drops tool results. */
export function generateReplayAnchor(messages: V2Message[]): GenerateReplayAnchor | undefined {
    let index = messages.length - 1;
    while (index >= 0 && !messages[index]?.id) index--;
    if (index < 0) return undefined;
    const id = messages.at(index)?.id;
    if (!id) return undefined;
    return { id, tail: clonePreservingInstances(messages.slice(index + 1)) };
}

interface ServedPrefix {
    anchor: GenerateReplayAnchor;
    model: string;
    agent: string;
    system: SessionContext["system"];
    messages: V2Message[];
    tools: SessionContext["tools"];
}

/** OpenCode's /btw requests reuse the last main request's system and history.
 * They never run the turn transform, which executes drops and advances counters. */
export class V2GenerateReplay {
    private readonly prefixes = new Map<string, ServedPrefix>();

    capture(draft: SessionContext, anchor: GenerateReplayAnchor | undefined): void {
        if (!anchor) {
            this.prefixes.delete(draft.sessionID);
            sessionLog(draft.sessionID, "generate replay capture skipped: no-anchor");
            return;
        }
        this.prefixes.set(draft.sessionID, {
            anchor: clonePreservingInstances(anchor),
            model: `${draft.model.providerID}/${draft.model.id}`,
            agent: draft.agent,
            system: clonePreservingInstances(draft.system),
            messages: clonePreservingInstances(draft.messages),
            tools: clonePreservingInstances(draft.tools),
        });
    }

    forget(sessionID: string): void {
        this.prefixes.delete(sessionID);
    }

    apply(draft: SessionContext): boolean {
        const prefix = this.prefixes.get(draft.sessionID);
        const skip = (reason: string): false => {
            sessionLog(draft.sessionID, `generate replay apply skipped: ${reason}`);
            return false;
        };
        if (!prefix) return skip("no-prefix");
        if (prefix.model !== `${draft.model.providerID}/${draft.model.id}`)
            return skip("model-mismatch");
        if (prefix.agent !== draft.agent) return skip("agent-mismatch");
        // Host checkpoints can remove the anchor. Without it we cannot distinguish
        // already-served history from the live tail, so leave the request alone.
        const index = draft.messages.findIndex((message) => message.id === prefix.anchor.id);
        if (index < 0) return skip("anchor-not-found");
        const end = index + 1 + prefix.anchor.tail.length;
        // Count alone can consume a new side question after a checkpoint removed
        // tool results. Match the original host tail, not its managed replacement.
        if (
            JSON.stringify(draft.messages.slice(index + 1, end)) !==
            JSON.stringify(prefix.anchor.tail)
        )
            return skip("anchor-tail-mismatch");
        const tail = draft.messages.slice(end);
        draft.messages.splice(
            0,
            draft.messages.length,
            ...clonePreservingInstances(prefix.messages),
            ...tail,
        );
        draft.system.splice(0, draft.system.length, ...clonePreservingInstances(prefix.system));
        // Tool definitions precede history in some provider cache keys. Reuse the
        // descriptions served by the main hook rather than the host's raw tools.
        draft.tools = clonePreservingInstances(prefix.tools);
        return true;
    }
}
