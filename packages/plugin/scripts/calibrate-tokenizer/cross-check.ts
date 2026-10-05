import { resolveModelCalibration } from "../../src/hooks/magic-context/tokenizer-calibration";

/** Compare only to an existing, measured tokenizer family; never to neutral guesses. */
export function crossCheck(provider: string, model: string, systemRatio: number, toolsRatio: number): { systemDelta: number; toolsDelta: number; failed: boolean } | null {
    let reference: [string, string] | undefined;
    if (provider === "anthropic" && ["claude-opus-4-7", "claude-sonnet-4-6"].includes(model)) reference = [provider, model];
    if (provider === "moonshot" && model === "kimi-k2.6") reference = ["opencode-go", "kimi-k2.6"];
    if (provider === "zai" && ["glm-5", "glm-5.1"].includes(model)) reference = ["opencode-go", "glm-5.1"];
    if (provider === "zai" && model === "glm-4.7") reference = ["cerebras", "zai-glm-4.7"];
    if (provider === "xai" && model.startsWith("grok-4")) reference = ["xai", "grok-4"];
    if (provider === "xai" && model.startsWith("grok-code-fast")) reference = ["xai", "grok-code-fast"];
    if (!reference) return null;
    const shipped = resolveModelCalibration(...reference);
    const systemDelta = systemRatio / shipped.systemRatio - 1;
    const toolsDelta = toolsRatio / shipped.toolsRatio - 1;
    return { systemDelta, toolsDelta, failed: Math.abs(systemDelta) > 0.05 || Math.abs(toolsDelta) > 0.05 };
}
