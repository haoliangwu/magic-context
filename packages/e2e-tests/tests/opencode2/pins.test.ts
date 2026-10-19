import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	// The server entry's version marker is part of host detection and stays pinned.
	// The v1 entry also registers background-only Zen agents. Native primary-request
	// tests verify that those registrations do not affect ordinary prompts or tools.
	for (const [path, expected] of Object.entries(pins)) {
		let bytes = readFileSync(resolve(root, path), "utf8");
		if (path === "packages/plugin/src/index.ts") {
			// The v1 entry shares this file with three v2-only additions: a setup
			// import, a setup type on the plugin object, and its setup property.
			// Remove only those additions so the hash protects v1; retain its version
			// registration because host detection depends on it.
			bytes = bytes
				.replace('import { setup } from "./v2/server";\n', "")
				.replace("PluginModule & { setup: typeof setup }", "PluginModule")
				.replace("    server,\n    setup,", "    server,");
		}
		expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
			expected,
		);
	}
});


test("native session API release pins agree across CI, Docker and packages", () => {
    const root = resolve(import.meta.dir, "../../../..");
    const read = (path: string) => readFileSync(resolve(root, path), "utf8");
    const plugin = JSON.parse(read("packages/plugin/package.json")).devDependencies;
    const e2e = JSON.parse(read("packages/e2e-tests/package.json")).devDependencies;
    for (const name of ["@opencode/cli", "@opencode/plugin", "@opencode/ai", "@opencode/client"]) {
        expect(plugin[name], name).toBe("2.0.22");
    }
    for (const name of ["@opencode/ai", "@opencode/client"]) expect(e2e[name], name).toBe("2.0.22");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("if (version !== 'opencode v2.0.22')");
    expect(ci).not.toContain("OpenCode 2.0.15");
    const docker = read("tests/docker/opencode2/Dockerfile");
    for (const name of ["@opencode/cli", "@opencode/cli-linux-x64", "@opencode/client"]) {
        expect(docker).toContain(`${name}@2.0.22`);
    }
});
