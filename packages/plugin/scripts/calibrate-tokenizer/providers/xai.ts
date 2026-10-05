import { type CountAdapter, functionTools, postCountJson } from "./counting";

/** Raw text tokenization omits the provider's hidden chat/tool prompt template. */
export const measureXai: CountAdapter = async (model, key, system, tools, prose) => {
    const count = async (text: string) => {
        const result = await postCountJson("https://api.x.ai/v1/tokenize-text", { authorization: `Bearer ${key}` }, { model, text });
        if (!Array.isArray(result.token_ids)) throw new Error("xAI returned no token_ids array");
        return result.token_ids.length;
    };
    const systemApi = await count(system);
    const toolsApi = await count(JSON.stringify(functionTools(tools).map((tool) => ({ type: "function", function: tool }))));
    const proseApi = await count(Object.values(prose).join("\n\n"));
    const sections: Record<string, number> = {};
    for (const [name, text] of Object.entries(prose)) sections[name] = await count(text);
    return { method: "tokenize-text", systemApi, toolsApi, proseApi, sections, caveat: "Raw SYSTEM text and JSON-serialized chat function tools, without hidden chat/tool prompt framing. Residual method error versus billed chat tokens is unmeasured; local TOOLS denominator retains the canonical fixture serialization." };
};
