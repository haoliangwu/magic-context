import { expect, test } from "bun:test";
import { createM0RenderOptions } from "./render-options";

test("M0 render options gate memory identity without disabling project docs", () => {
    for (const enabled of [true, false]) {
        const options = createM0RenderOptions(
            {
                memoryConfig: { enabled, injectionBudgetTokens: 1000, autoPromote: false },
                injectDocs: true,
            },
            { percentage: 0, inputTokens: 0 },
            "openai/gpt-4.1",
            1000000,
            "git:project",
        );
        expect(options.projectPath).toBe(enabled ? "git:project" : undefined);
        expect(options.memoryEnabled).toBe(enabled);
        expect(options.memoryInjectionBudgetTokens).toBe(1000);
        expect(options.injectDocs).toBe(true);
    }
});
