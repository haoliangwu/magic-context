import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the union server defers the context adapter until after the host-shape check", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).not.toContain('import { registerContext } from "./hooks/context"');
    const guard = source.indexOf("if (!isOpenCode2HostContext(context))");
    const load = source.indexOf('await import("./hooks/context")');
    expect(guard).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(guard);
    expect(source.slice(guard, load)).toContain("return async () => {}");
});
