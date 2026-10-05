// Resolve the plugin workspace's installed SDK; e2e-tests does not depend on it.
import { tool } from "../../../plugin/node_modules/@opencode-ai/plugin/dist/tool.js";

/** Deterministic communication stand-ins, exercised through the real host loop. */
export default async () => ({
    tool: {
        peer_send: tool({
            description: "Send a PM to a peer.",
            args: { agent: tool.schema.string(), message: tool.schema.string() },
            async execute() { return "queued pmid=pm_host_proof"; },
        }),
        ask: tool({
            description: "Ask the operator which mode to use.",
            args: { question: tool.schema.string(), options: tool.schema.array(tool.schema.string()) },
            async execute() { return "Strict: preserve call boundaries."; },
        }),
    },
});
