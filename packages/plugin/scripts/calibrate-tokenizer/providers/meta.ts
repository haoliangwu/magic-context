import { type CountAdapter, functionTools, measureRequests, postCountJson, requireCount } from "./counting";

export const META_COUNT_CAVEAT = "Preflight rendered-context count, baseline-subtracted. Meta usage.input_tokens is cumulative across hosted-tool iterations with injected-token accounting adjustments; it is not final-context occupancy or directly comparable billing.";

/** Preflight counts describe rendered context, not cumulative hosted-tool billing usage. */
export const measureMeta: CountAdapter = async (model, key, system, tools, prose) => {
    const result = await measureRequests("input_tokens", async (probe) => {
        const response = await postCountJson("https://api.meta.ai/v1/responses/input_tokens", { authorization: `Bearer ${key}` }, {
            model, input: [{ role: "user", content: probe.user }],
            ...(probe.system ? { instructions: probe.system } : {}),
            ...(probe.tools ? { tools: functionTools(tools).map((tool) => ({ type: "function", ...tool })) } : {}),
        });
        return requireCount(response.input_tokens);
    }, system, prose);
    return { ...result, caveat: META_COUNT_CAVEAT };
};
