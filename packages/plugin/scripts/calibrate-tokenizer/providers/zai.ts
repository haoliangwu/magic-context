import { type CountAdapter, functionTools, measureRequests, postCountJson, requireCount } from "./counting";

/** Z.ai's tokenizer accepts chat messages and function definitions without inference. */
export const measureZai: CountAdapter = async (model, key, system, tools, prose) => {
    return measureRequests("paas/v4/tokenizer", async (probe) => {
        const result = await postCountJson("https://api.z.ai/api/paas/v4/tokenizer", { authorization: `Bearer ${key}` }, {
            model,
            messages: [...(probe.system ? [{ role: "system", content: probe.system }] : []), { role: "user", content: probe.user }],
            ...(probe.tools ? { tools: functionTools(tools).map((tool) => ({ type: "function", function: tool })) } : {}),
        });
        return requireCount((result.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens);
    }, system, prose);
};
