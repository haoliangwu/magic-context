import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Loads the built Magic Context plugin unchanged and records what the provider
// relay cannot see: the reply text before Magic Context strips tags for storage,
// and whether Magic Context's dropped-input guard refused a tool call.
const record = (event) =>
    appendFileSync(
        process.env.PRIMING_CAPTURE,
        `${JSON.stringify({ at: Date.now(), ...event })}\n`,
    );

// In the neutral arm the model only ever sees `(removed: tag N)`, so a copied
// placeholder in tool arguments has that shape. Map it to the bracket render
// before Magic Context's dropped-input guard runs, so the unchanged guard refuses
// it exactly as it would refuse `[dropped §N§]`, and reword the refusal back.
const neutral = process.env.PRIMING_PLACEHOLDER === "neutral";
const NEUTRAL_VALUE = /^\(removed: tag (\d+)\)$/;
function toBracket(value) {
    if (typeof value === "string") return value.replace(NEUTRAL_VALUE, "[dropped §$1§]");
    if (Array.isArray(value)) return value.map(toBracket);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, toBracket(item)]),
        );
    return value;
}
const toNeutral = (text) =>
    text
        .replace(
            /\{\\?"dropped\\?":\\?"\[dropped §(\d+)§\]\\?"\}/g,
            '{"removed":"(removed: tag $1)"}',
        )
        .replace(/\[dropped §(\d+)§\]/g, "(removed: tag $1)");

export default {
    id: "priming-trial",
    server: async (input, options) => {
        const { default: mc } = await import(pathToFileURL(process.env.PRIMING_DIST).href);
        const hooks = await mc.server(input, options);
        const complete = hooks["experimental.text.complete"];
        const before = hooks["tool.execute.before"];
        return {
            ...hooks,
            "experimental.text.complete": async (input, output) => {
                record({
                    kind: "raw",
                    session: input.sessionID,
                    message: input.messageID,
                    part: input.partID,
                    text: output.text,
                });
                await complete?.(input, output);
                record({
                    kind: "stored",
                    session: input.sessionID,
                    message: input.messageID,
                    part: input.partID,
                    text: output.text,
                });
            },
            "tool.execute.before": async (input, output) => {
                const args = JSON.stringify(output.args ?? {});
                const mapped = neutral ? toBracket(output.args) : output.args;
                const changed = JSON.stringify(mapped ?? {}) !== args;
                try {
                    try {
                        await before?.(input, changed ? { ...output, args: mapped } : output);
                    } catch (error) {
                        if (!neutral) throw error;
                        throw new Error(toNeutral(String(error?.message ?? error)));
                    }
                    record({
                        kind: "tool",
                        session: input.sessionID,
                        tool: input.tool,
                        call: input.callID,
                        args,
                    });
                } catch (error) {
                    record({
                        kind: "tool",
                        session: input.sessionID,
                        tool: input.tool,
                        call: input.callID,
                        args,
                        refused: String(error?.message ?? error).slice(0, 400),
                    });
                    throw error;
                }
            },
        };
    },
};
