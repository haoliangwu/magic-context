#!/usr/bin/env bun
// Install the pinned OpenCode 2 CLI once per machine, outside any checkout.
//
// Local OpenCode 2 lane runs resolve the CLI from this shared install before the
// worktree's node_modules copy (see src/opencode2-runner/cli-resolution.ts), so
// macOS assesses one executable per CLI version instead of one per worktree.
// CI does not call this: its runners are fresh machines with nothing to share.
//
// Usage: bun packages/e2e-tests/scripts/ensure-shared-opencode2.ts
// Prints the shared binary path on success. Safe to run from several workers at
// once: each installs into its own temporary directory beside the target and
// renames it into place, so a half-finished install is never visible at the
// target path.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	installedOpenCode2Version,
	pinnedOpenCode2Version,
	type SharedOpenCode2Install,
	sharedOpenCode2Install,
	sharedOpenCode2Root,
} from "../src/opencode2-runner/cli-resolution";

/** True when the binary runs and reports exactly `version` (the CLI prints `opencode v<version>`). */
function binaryReportsVersion(binary: string, version: string): boolean {
	if (!existsSync(binary)) return false;
	const result = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) return false;
	return (
		result.stdout
			.trim()
			.replace(/^opencode\s+/, "")
			.replace(/^v/, "") === version
	);
}

function isComplete(install: SharedOpenCode2Install, version: string): boolean {
	return (
		installedOpenCode2Version(install) === version &&
		binaryReportsVersion(install.binary, version)
	);
}

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed in ${cwd} (status ${result.status}, signal ${result.signal})`,
		);
	}
}

/** Install `version` into `staging` and leave it verified; throws if the binary cannot be made to run. */
function installInto(staging: string, version: string): void {
	writeFileSync(
		join(staging, "package.json"),
		`${JSON.stringify(
			{
				name: "magic-context-e2e-opencode-cli",
				private: true,
				dependencies: { "@opencode/cli": version },
				// Lets Bun run the CLI's postinstall, which puts the platform binary in bin/.
				trustedDependencies: ["@opencode/cli"],
			},
			null,
			2,
		)}\n`,
	);
	// Hoisted keeps the platform package next to @opencode/cli, where its postinstall looks for it.
	run(process.execPath, ["install", "--linker=hoisted"], staging);
	const binary = join(staging, "node_modules/@opencode/cli/bin/opencode.exe");
	const cliDirectory = dirname(dirname(binary));
	if (!binaryReportsVersion(binary, version)) {
		// Bun can skip lifecycle scripts; this is the same manual step the lane README gives for node_modules.
		run(process.execPath, ["postinstall.mjs"], cliDirectory);
	}
	if (!binaryReportsVersion(binary, version)) {
		throw new Error(
			`OpenCode CLI in ${staging} does not answer --version with ${version}`,
		);
	}
}

export function ensureSharedOpenCode2(
	version: string = pinnedOpenCode2Version(),
	root: string = sharedOpenCode2Root(),
): string {
	const install = sharedOpenCode2Install(version, root);
	if (isComplete(install, version)) return install.binary;

	mkdirSync(root, { recursive: true });
	if (existsSync(install.directory)) {
		// Another worker may have renamed a finished install into place since the first
		// check; re-verify so a good install is never thrown away.
		if (isComplete(install, version)) return install.binary;
		// A directory that still fails verification was damaged after its install finished.
		// Move it out of the way atomically before deleting, so a concurrent reader never
		// sees it half-removed.
		const stale = join(root, `.${version}.stale-${process.pid}-${Date.now()}`);
		try {
			renameSync(install.directory, stale);
			rmSync(stale, { recursive: true, force: true });
		} catch (error) {
			// Another worker may have replaced it already; the checks below decide.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	const staging = mkdtempSync(join(root, `.${version}.tmp-`));
	try {
		installInto(staging, version);
		try {
			renameSync(staging, install.directory);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Losing the race to another worker is fine as long as the winner is complete.
			if (
				(code === "ENOTEMPTY" || code === "EEXIST") &&
				isComplete(install, version)
			) {
				return install.binary;
			}
			throw error;
		}
	} finally {
		if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
	}

	if (!isComplete(install, version)) {
		throw new Error(
			`Shared OpenCode CLI at ${install.directory} failed verification after install`,
		);
	}
	return install.binary;
}

if (import.meta.main) {
	try {
		console.log(ensureSharedOpenCode2());
	} catch (error) {
		console.error(
			`ensure-shared-opencode2 (${basename(import.meta.path)}): ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
