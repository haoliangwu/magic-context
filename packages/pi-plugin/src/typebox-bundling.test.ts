import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One published package serves both Pi and OMP, so TypeBox must stay bundled
// into dist/. OMP's extension loader rewrites every bare `typebox` (and
// `@sinclair/typebox`) import to its own omptype-based shim. That shim builds
// schemas as callable objects instead of JSON Schema, so they fail
// structuredClone in the tool registration path and the whole extension fails
// to load on OMP ("The object can not be cloned."). Pi would accept an external
// import, but OMP would not.

interface PiPluginPackageJson {
	scripts: Record<string, string>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const packageJson = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as PiPluginPackageJson;

function externalsOfExtensionBundle(buildScript: string): string[] {
	const step = buildScript
		.split("&&")
		.map((part) => part.trim())
		.find((part) => part.startsWith("bun build src/index.ts"));
	if (!step) {
		throw new Error(
			"build script no longer contains the `bun build src/index.ts` step this test inspects",
		);
	}
	return [...step.matchAll(/--external\s+(\S+)/g)].map((match) => match[1]);
}

describe("TypeBox packaging for the shared Pi/OMP package", () => {
	it("bundles typebox into the extension build instead of leaving it external", () => {
		const externals = externalsOfExtensionBundle(packageJson.scripts.build);
		// Guard that the parser found the real step: the host packages are always external.
		expect(externals).toContain("@earendil-works/pi-coding-agent");
		expect(externals.filter((name) => /typebox/.test(name))).toEqual([]);
	});

	it("declares host-provided typebox as an optional peer while bundling it", () => {
		expect(packageJson.dependencies?.typebox).toBeUndefined();
		expect(packageJson.peerDependencies?.typebox).toBe("*");
		expect(packageJson.peerDependenciesMeta?.typebox?.optional).toBe(true);
	});
});
