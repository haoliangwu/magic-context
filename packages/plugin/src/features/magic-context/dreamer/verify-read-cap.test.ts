import { expect, it } from "bun:test";

import { capDreamerReadOutput, DREAMER_READ_MAX_CHARS } from "./verify-read-cap";

it("caps mapper and verify plain read results without affecting other agents or tools", () => {
    const output = { output: "a".repeat(DREAMER_READ_MAX_CHARS + 100) };
    expect(capDreamerReadOutput({ agent: "dreamer-docs", tool: "read" }, output)).toBe(false);
    expect(output.output).toHaveLength(DREAMER_READ_MAX_CHARS + 100);
    expect(capDreamerReadOutput({ agent: "dreamer-memory-mapper", tool: "read" }, output)).toBe(
        true,
    );
    expect(output.output).toContain("Use offset/limit");
    expect(output.output.length).toBeLessThan(DREAMER_READ_MAX_CHARS + 100);
});
