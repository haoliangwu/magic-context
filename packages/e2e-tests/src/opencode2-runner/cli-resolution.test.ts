import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	pinnedOpenCode2Version,
	resolveOpenCode2CLI,
	sharedOpenCode2Install,
	sharedOpenCode2Root,
} from "./cli-resolution";
import { assertOpenPaths } from "./spawn";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-oc2-cli-resolution-"));
	roots.push(root);
	const sharedRoot = join(root, "shared");
	const nodeModules = join(root, "node_modules/.bin/opencode2");
	mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
	writeFileSync(nodeModules, "");
	const override = join(root, "override-opencode");
	writeFileSync(override, "");
	/** Lay out a shared install whose manifest claims `manifestVersion`, filed under `directoryVersion`. */
	const share = (
		directoryVersion: string,
		manifestVersion: string,
		withBinary = true,
	) => {
		const install = sharedOpenCode2Install(directoryVersion, sharedRoot);
		mkdirSync(join(install.binary, ".."), { recursive: true });
		writeFileSync(
			install.packageJson,
			JSON.stringify({ name: "@opencode/cli", version: manifestVersion }),
		);
		if (withBinary) writeFileSync(install.binary, "");
		return install;
	};
	return { root, sharedRoot, nodeModules, override, share };
}

describe("OpenCode 2 CLI resolution order", () => {
	test("MC_E2E_OPENCODE2_CLI wins over a valid shared install", () => {
		const f = fixture();
		f.share("2.0.22", "2.0.22");
		expect(
			resolveOpenCode2CLI({
				override: f.override,
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(f.override);
	});

	test("a missing MC_E2E_OPENCODE2_CLI is an error, not a fallthrough", () => {
		const f = fixture();
		f.share("2.0.22", "2.0.22");
		expect(() =>
			resolveOpenCode2CLI({
				override: join(f.root, "absent"),
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toThrow("MC_E2E_OPENCODE2_CLI does not exist");
	});

	test("the shared install for the pinned version wins over node_modules", () => {
		const f = fixture();
		const install = f.share("2.0.22", "2.0.22");
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(install.binary);
	});

	test("a shared install whose manifest reports another version falls through to node_modules", () => {
		const f = fixture();
		// Filed under the pinned directory name but actually a different build.
		f.share("2.0.22", "2.0.21");
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(f.nodeModules);
	});

	test("a shared install for a different version is never picked", () => {
		const f = fixture();
		f.share("2.0.21", "2.0.21");
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(f.nodeModules);
	});

	test("a shared manifest without its binary falls through to node_modules", () => {
		const f = fixture();
		f.share("2.0.22", "2.0.22", false);
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(f.nodeModules);
	});

	test("no readable pin skips the shared install", () => {
		const f = fixture();
		f.share("2.0.22", "2.0.22");
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: null,
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [f.nodeModules],
			}),
		).toBe(f.nodeModules);
	});

	test("node_modules candidates keep their order, and the first is the fallback when none exist", () => {
		const f = fixture();
		const missing = join(f.root, "plugin/node_modules/.bin/opencode2");
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [missing, f.nodeModules],
			}),
		).toBe(f.nodeModules);
		expect(
			resolveOpenCode2CLI({
				pinnedVersion: "2.0.22",
				sharedRoot: f.sharedRoot,
				nodeModulesCandidates: [missing, join(f.root, "also-missing")],
			}),
		).toBe(missing);
	});
});

describe("OpenCode 2 CLI pin", () => {
	test("reads the exact @opencode/cli devDependency from packages/plugin", () => {
		expect(pinnedOpenCode2Version()).toBe("2.0.22");
	});

	test("refuses a range, since a shared install is matched by exact version", () => {
		const f = fixture();
		const manifest = join(f.root, "package.json");
		writeFileSync(
			manifest,
			JSON.stringify({ devDependencies: { "@opencode/cli": "^2.0.22" } }),
		);
		expect(() => pinnedOpenCode2Version(manifest)).toThrow("exact version");
	});

	test("the shared root sits under the given home, outside any checkout", () => {
		expect(sharedOpenCode2Root("/home/u")).toBe(
			"/home/u/.local/share/cortexkit/e2e-bin/opencode-cli",
		);
		expect(sharedOpenCode2Install("2.0.22", "/r").binary).toBe(
			"/r/2.0.22/node_modules/@opencode/cli/bin/opencode.exe",
		);
	});

	test("the unmodified open-path guard accepts the shared binary", () => {
		// The shared root must stay outside every directory the guard protects (for
		// example ~/.local/share/cortexkit/magic-context), or every host run fails.
		const binary = sharedOpenCode2Install(
			"2.0.22",
			sharedOpenCode2Root(homedir()),
		).binary;
		expect(() =>
			assertOpenPaths([binary], "/tmp/mc-opencode2-guard-root"),
		).not.toThrow();
	});
});
