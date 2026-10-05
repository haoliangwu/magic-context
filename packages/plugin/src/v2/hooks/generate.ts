import { clonePreservingInstances } from "./payload";
import type { SessionContext, V2Message } from "./types";

interface ServedPrefix {
    anchor: string;
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

    capture(draft: SessionContext, anchor: string | undefined): void {
        if (!anchor) return;
        this.prefixes.set(draft.sessionID, {
            anchor,
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
        if (
            !prefix ||
            prefix.model !== `${draft.model.providerID}/${draft.model.id}` ||
            prefix.agent !== draft.agent
        )
            return false;
        // Host checkpoints can remove the anchor. Without it we cannot distinguish
        // already-served history from the live tail, so leave the request alone.
        const index = draft.messages.findIndex((message) => message.id === prefix.anchor);
        if (index < 0) return false;
        const tail = draft.messages.slice(index + 1);
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
