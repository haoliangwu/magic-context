import { isRecord } from "./record-type-guard";

/** Host-owned answer metadata, independent of the tool's registered name. */
export function hasUserAnswerMetadata(value: unknown): boolean {
    if (!isRecord(value)) return false;
    if (value.userAnswer === true) return true;
    if (Array.isArray(value.answers)) return true;
    if (typeof value.answer === "string") return true;
    if (Array.isArray(value.selectedOptions) || typeof value.customInput === "string") return true;
    return Array.isArray(value.results) && value.results.some(hasUserAnswerMetadata);
}

export function toolPartHasUserAnswer(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const state = isRecord(part.state) ? part.state : undefined;
    return hasUserAnswerMetadata(state?.metadata) || hasUserAnswerMetadata(part.details);
}
