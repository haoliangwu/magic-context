import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const instruction =
    "Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.";
const instructionC =
    'Every user message, every text you write and every tool result in this conversation carries a tag such as §12§, numbered in the order they arrive. Start the text of each reply with exactly §N§ and one space, where N is one more than the highest tag number you can see, tool results included. That applies to every reply that has text, including a short sentence written alongside tool calls, for example `§12§ Reading both files in parallel.` followed by the calls. A reply that is only tool calls gets no tag. IMPORTANT: NEVER write tag notation anywhere else: not mid-text and not in tool arguments. To refer to an item in your prose, write "tag 12".';
const record = (event) =>
    appendFileSync(process.env.SELF_TAG_CAPTURE, JSON.stringify(event) + "\n");
const control = () =>
    process.env.SELF_TAG_CONTROL
        ? JSON.parse(readFileSync(process.env.SELF_TAG_CONTROL, "utf8"))
        : { variant: process.env.SELF_TAG_VARIANT, head: !!process.env.SELF_TAG_HEAD_FIXTURE };

export default {
    id: "self-tag-trial",
    server: async (input, options) => {
        const { default: mc } = await import(pathToFileURL(process.env.SELF_TAG_DIST).href);
        const hooks = await mc.server(input, options);
        const complete = hooks["experimental.text.complete"];
        const system = hooks["experimental.chat.system.transform"];
        const transform = hooks["experimental.chat.messages.transform"];
        return {
            ...hooks,
            tool: {
                ...hooks.tool,
                trial_read: tool({
                    description:
                        "Read deterministic fixture.txt; padding=true also returns a large irrelevant reference appendix",
                    args: { padding: tool.schema.boolean().optional() },
                    execute: async ({ padding }) =>
                        "fixture.txt: " +
                        readFileSync(new URL("./fixtures/fixture.txt", import.meta.url), "utf8") +
                        (padding
                            ? "Reference appendix (not fruit counts):\n" +
                              "reference line: alpha beta gamma delta epsilon zeta eta theta iota kappa\n".repeat(
                                  500,
                              )
                            : ""),
                }),
                trial_echo: tool({
                    description: "Run deterministic echo",
                    args: { text: tool.schema.string() },
                    execute: async ({ text }) => `${text}\n`,
                }),
                trial_list: tool({
                    description: "List deterministic fixture directory",
                    args: {},
                    execute: async () => "fixture.txt\nREADME.md\n",
                }),
            },
            "experimental.text.complete": async (input, output) => {
                // Record raw text before Magic Context removes tags for storage.
                record({ kind: "raw", input, text: output.text });
                await complete?.(input, output);
                record({ kind: "stripped", input, text: output.text });
            },
            "experimental.chat.system.transform": async (input, output) => {
                await system?.(input, output);
                if (control().variant === "B") output.system.push(instruction);
                if (["C", "D"].includes(control().variant)) output.system.push(instructionC);
                record({ kind: "system", system: output.system });
            },
            "experimental.chat.messages.transform": async (input, output) => {
                await transform?.(input, output);
                if (control().head && output.messages[0]?.info.syntheticHead) {
                    output.messages[0].parts[0].text +=
                        "\n<project-memory>Quoted earlier handle: §9001§ is a literal, not a live tag.</project-memory>";
                }
                record({ kind: "wire", messages: output.messages });
                // Capture the final reply after Magic Context transforms history, then stop
                // before OpenCode sends another provider request.
                const latestUser = [...output.messages]
                    .reverse()
                    .find(
                        (message) =>
                            message.info.role === "user" &&
                            message.info.id &&
                            !message.info.syntheticHead,
                    );
                if (
                    latestUser?.parts.some(
                        (part) =>
                            part.type === "text" && part.text.includes("__SELF_TAG_FLUSH_ONLY__"),
                    )
                ) {
                    record({ kind: "flush", session: output.messages.at(-1)?.info.sessionID });
                    throw new Error(
                        "SELF_TAG_FLUSH_ONLY: transform captured; provider call intentionally prevented",
                    );
                }
            },
            "tool.execute.before": async (input, output) => {
                record({ kind: "tool", input, args: output.args });
                await hooks["tool.execute.before"]?.(input, output);
            },
        };
    },
};
