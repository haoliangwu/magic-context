import { appendFileSync } from "node:fs";
import { Message } from "@opencode/ai/schema/messages";
import { Media } from "@opencode/ai/media";

const trace = process.env.MC_E2E_SCHEMA_TRACE_PATH;

function forInstalledSchema(message) {
    return {
        ...message,
        content: message.content.map((part) => {
            if (part.type !== "media") return part;
            const original = part.media;
            if (!original || typeof original !== "object" ||
                Object.getPrototypeOf(original) === Object.prototype || !original.source) {
                throw new Error("media has no host Media.Asset instance");
            }
            // The host and the installed test schema have separate Asset constructors. Keep the
            // host instance on the live draft; make an equivalent instance solely for checking
            // this package's LLM Message schema. The host validates the original after the hook.
            return { ...part, media: Media.from(original.source) };
        }),
    };
}

export default {
    id: "mc-e2e-llm-schema-guard",
    async setup(context) {
        await context.session.hook("context", (draft) => {
            for (const [messageIndex, message] of draft.messages.entries()) {
                try {
                    Message.make(forInstalledSchema(message));
                } catch (error) {
                    let partIndex = -1;
                    for (const [index, part] of message.content.entries()) {
                        try {
                            Message.make(forInstalledSchema({ ...message, content: [part] }));
                        } catch {
                            partIndex = index;
                            break;
                        }
                    }
                    const part = message.content[partIndex];
                    const detail = {
                        sessionID: draft.sessionID,
                        messageIndex,
                        partIndex,
                        part: part === undefined ? null : part,
                        error: String(error),
                    };
                    const line = JSON.stringify(detail);
                    if (trace) appendFileSync(trace, `FAIL ${line}\n`);
                    throw new Error(`OC2 LLM schema guard: ${line}`);
                }
            }
            if (trace) appendFileSync(trace, `PASS ${draft.sessionID} ${draft.messages.length}\n`);
        });
    },
};
