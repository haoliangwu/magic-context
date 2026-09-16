import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	for (const [path, expected] of Object.entries(pins)) {
		let bytes = readFileSync(resolve(root, path), "utf8");
		if (path === "packages/plugin/src/index.ts") {
			// The dual-loader composition is additive. Keep the original whole
			// v1 entry golden after removing only those three exact additions.
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
