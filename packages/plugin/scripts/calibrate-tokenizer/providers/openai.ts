import { type CountAdapter, functionTools, measureRequests, postCountJson, requireCount } from "./counting";

/** API-key Responses counting, not the separate ChatGPT/Codex OAuth usage path. */
export const measureOpenAI: CountAdapter = async (model, key, system, tools, prose) => {
    return measureRequests("responses/input_tokens", async (probe) => {
        const result = await postCountJson("https://api.openai.com/v1/responses/input_tokens", { authorization: `Bearer ${key}` }, {
            model, input: [{ role: "user", content: probe.user }],
            ...(probe.system ? { instructions: probe.system } : {}),
            ...(probe.tools ? { tools: functionTools(tools).map((tool) => ({ type: "function", ...tool })) } : {}),
        });
        return requireCount(result.input_tokens);
    }, system, prose);
};
