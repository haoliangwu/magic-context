import { describe, it } from "bun:test";
import { cases, checkProtectedToolsCase } from "./protected-tools-fixture.test";

describe("protected_tools selection golden (TypeScript)", () => {
    for (const spec of cases) it(spec.label, () => checkProtectedToolsCase(spec));
});
