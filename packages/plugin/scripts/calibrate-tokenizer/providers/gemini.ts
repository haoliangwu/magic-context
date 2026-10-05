import { type CountAdapter, functionTools, measureRequests, postCountJson, requireCount } from "./counting";

/** Public Gemini API-key counting; antigravity OAuth is deliberately not accepted. */
export const measureGemini: CountAdapter = async (model, key, system, tools, prose) => {
    return measureRequests("countTokens", async (probe) => {
        const result = await postCountJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`, { "x-goog-api-key": key }, {
            generateContentRequest: {
                model: `models/${model}`,
                contents: [{ role: "user", parts: [{ text: probe.user }] }],
                ...(probe.system ? { systemInstruction: { parts: [{ text: probe.system }] } } : {}),
                ...(probe.tools ? { tools: [{ functionDeclarations: functionTools(tools).map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) }] } : {}),
            },
        });
        return requireCount(result.totalTokens);
    }, system, prose);
};
