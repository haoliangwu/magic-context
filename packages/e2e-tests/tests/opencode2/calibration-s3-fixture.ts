import { buildCompartmentAgentPrompt } from "../../../plugin/src/hooks/magic-context/compartment-prompt";

export const calibrationPrompt = buildCompartmentAgentPrompt({
    seedExamples: "", sessionReferences: "", projectMemory: "", memoryEnabled: false,
    inputSource: "Messages 1-2:\n\n[1] U: Preserve the stable tag identity when restoring the raw tail.\n[2] A: Restore unarchived rows in host sequence order.",
});
export const calibrationChunk = { startIndex: 1, endIndex: 2, lines: [{ ordinal: 1, messageId: "source-user" }, { ordinal: 2, messageId: "source-assistant" }] };
export const calibrationOutput = '<compartment start="1" end="2" title="Stable restoration"><p1>Preserve stable tag identity and restore unarchived rows in host sequence order.</p1></compartment>';
