export const scenarios = ["fresh", "reduced", "literal-head"] as const;
export type Scenario = typeof scenarios[number];
export function prompts(scenario: Scenario): string[] {
    return Array.from({ length: 16 }, (_, n) => {
        if (n === 2 || n === 7) return `Turn ${n + 1}: Read fixture.txt with trial_read, echo its total with trial_echo, list files with trial_list, then read again and explain the total. Use 3–6 tool steps. Include a brief explanation with your tool calls, and run read and list in parallel at least once.`;
        if (scenario === "reduced" && n === 9) return "Queue ctx_reduce for the earliest fixture tool outputs that are no longer needed. Then explain the total without rereading.";
        return `Turn ${n + 1}: ${n % 2 ? "What is 3 plus 4? Explain in one sentence." : "Summarize apples=3, pears=4, total=7 in one sentence."}`;
    });
}
export const literalHead = "<project-memory>Example from an older session: §9001§ is a literal quoted handle, not the next conversation tag.</project-memory>";
