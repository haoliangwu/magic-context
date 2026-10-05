import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("TUI registration is not gated by toast RPC discovery in source or shipped copy", () => {
    for (const path of ["./index.tsx", "../tui-compiled/index.tsx"]) {
        const source = readFileSync(new URL(path, import.meta.url), "utf8");
        const initialization = source.indexOf("initRpcClient(directory)");
        expect(initialization).toBeGreaterThan(0);
        const startup = source.slice(initialization);
        const registration = startup.indexOf("api.slots.register(sidebarSlot)");
        expect(registration).toBeGreaterThan(0);
        const beforeRegistration = startup.slice(0, registration);
        expect(beforeRegistration).toContain("void refreshToastDurationMs()");
        expect(beforeRegistration).not.toContain("await refreshToastDurationMs()");
    }
});
