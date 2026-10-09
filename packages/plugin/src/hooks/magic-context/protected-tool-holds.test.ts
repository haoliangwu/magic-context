import { it } from "bun:test";
import { checkProtectedToolHold, holdCases } from "./protected-tool-holds-fixture.test";

for (const spec of holdCases)
    it(`TypeScript held drop: ${spec.label}`, () => checkProtectedToolHold(spec));
