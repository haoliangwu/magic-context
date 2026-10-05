import { type CountAdapter, functionTools, measureRequests, postCountJson, requireCount } from "./counting";

/** Moonshot's chat-shaped estimate endpoint; no completion is requested. */
export const measureKimi: CountAdapter = async (model, key, system, tools, prose) => {
    return measureRequests("tokenizers/estimate-token-count", async (probe) => {
        const result = await postCountJson("https://api.moonshot.ai/v1/tokenizers/estimate-token-count", { authorization: `Bearer ${key}` }, {
            model,
            messages: [...(probe.system ? [{ role: "system", content: probe.system }] : []), { role: "user", content: probe.user }],
            ...(probe.tools ? { tools: functionTools(tools).map((tool) => ({ type: "function", function: tool })) } : {}),
        });
        if (result.error) throw new Error("Moonshot estimate returned an error");
        return requireCount((result.data as { total_tokens?: number } | undefined)?.total_tokens);
    }, system, prose);
};
