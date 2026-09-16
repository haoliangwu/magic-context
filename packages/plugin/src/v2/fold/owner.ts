import { createHash } from "node:crypto";
import type { V2Context, V2Message } from "../hooks/types";

export const foldDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface FoldIdentity {
    watermark: number;
    cutSeq?: number;
    submitted: string;
    submittedSha: string;
    rendered?: V2Message;
    renderedSha?: string;
    renderedSummary?: string;
    rejectedSha?: string;
    reason?: "host_rerender" | "host_cut_before_watermark" | "boot_recovery";
}

/** A host checkpoint has two identities: our submitted summary and its rendered wrapper.
 * GA provider compaction dispatches the hook before Started (mime-hxnftcv1.js:385/387);
 * the projector assigns seq from the later event (mime-26m96hf0.js:252-260).
 * Never predict that seq: persist a provisional source watermark, then bind the actual row.
 */
export class FoldOwner {
    private readonly pending = new Map<string, Promise<unknown>>();
    constructor(private readonly storage: V2Context["storage"]) {}
    private async serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(sessionID) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.pending.set(sessionID, next);
        try {
            return await next;
        } finally {
            if (this.pending.get(sessionID) === next) this.pending.delete(sessionID);
        }
    }
    private key(sessionID: string) {
        return `fold/v1/${sessionID}`;
    }
    async read(sessionID: string): Promise<FoldIdentity | undefined> {
        return (await this.storage.get(this.key(sessionID))) as FoldIdentity | undefined;
    }
    async supply(args: {
        sessionID: string;
        watermark: number;
        runningCut?: number;
        materialize: () => string;
    }): Promise<FoldIdentity> {
        return this.serial(args.sessionID, async () => {
            const previous = await this.read(args.sessionID);
            const same =
                previous &&
                (args.runningCut !== undefined
                    ? previous.cutSeq === args.runningCut
                    : previous.cutSeq === undefined && previous.watermark === args.watermark);
            if (same) return previous;
            const submitted = args.materialize();
            const next: FoldIdentity = {
                watermark: args.watermark,
                cutSeq: args.runningCut,
                submitted,
                submittedSha: foldDigest(submitted),
            };
            await this.storage.set(this.key(args.sessionID), next);
            return next;
        });
    }
    async observe(args: {
        sessionID: string;
        cutSeq: number;
        summary: string;
        rendered: V2Message;
        onHard: (reason: NonNullable<FoldIdentity["reason"]>) => void;
    }): Promise<FoldIdentity> {
        return this.serial(args.sessionID, async () => {
            let state = await this.read(args.sessionID);
            const renderedSha = foldDigest(JSON.stringify(args.rendered));
            // An already-persisted checkpoint can predate the plugin's storage commit.
            // Recover its two identities without draining any pending operation twice.
            if (!state) {
                args.onHard("boot_recovery");
                state = {
                    watermark: args.cutSeq,
                    submitted: args.summary,
                    submittedSha: foldDigest(args.summary),
                    reason: "boot_recovery",
                };
            }
            const reason =
                args.cutSeq < state.watermark
                    ? "host_cut_before_watermark"
                    : state.submittedSha !== foldDigest(args.summary) ||
                        (state.renderedSha && state.renderedSha !== renderedSha)
                      ? "host_rerender"
                      : undefined;
            if (reason && state.rejectedSha !== renderedSha) {
                args.onHard(reason);
                state.reason = reason;
                state.rejectedSha = renderedSha;
            }
            if (state.cutSeq === undefined && args.cutSeq >= state.watermark)
                state.cutSeq = args.cutSeq;
            if (!state.rendered && reason !== "host_cut_before_watermark") {
                state.rendered = structuredClone(args.rendered);
                state.renderedSha = renderedSha;
                state.renderedSummary = args.summary;
            }
            await this.storage.set(this.key(args.sessionID), state);
            return state;
        });
    }
}
