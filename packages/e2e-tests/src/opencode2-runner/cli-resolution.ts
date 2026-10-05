import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the OpenCode 2 lane finds the GA CLI binary.
//
// Every worktree gets its own byte-identical copy of the CLI in node_modules
// (Bun's linker clones files), and macOS runs a malware assessment the first
// time each new executable file runs. Many worktrees therefore mean many
// assessments of the same 170 MB binary. Local runs instead use one shared
// install per pinned version, kept outside any checkout, so that assessment
// happens once. The shared directory only ever holds the CLI package; the
// lane's host data always lives under a per-test throwaway root.

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PLUGIN_PACKAGE_JSON = join(REPO_ROOT, "packages/plugin/package.json");

/** The exact `@opencode/cli` version the plugin package pins as a devDependency. */
export function pinnedOpenCode2Version(
	packageJsonPath: string = PLUGIN_PACKAGE_JSON,
): string {
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		devDependencies?: Record<string, string>;
	};
	const version = manifest.devDependencies?.["@opencode/cli"];
	if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(
			`packages/plugin must pin @opencode/cli to an exact version; found ${JSON.stringify(version)}`,
		);
	}
	return version;
}

/**
 * Parent of the per-version shared installs. Uses the real home directory, never XDG_DATA_HOME,
 * because tests redirect XDG roots. It is a sibling of magic-context/, not inside it: the lane's
 * open-path guard (assertOpenPaths) refuses any host file under the live magic-context directory.
 */
export function sharedOpenCode2Root(home: string = homedir()): string {
	return join(home, ".local/share/cortexkit/e2e-bin/opencode-cli");
}

export interface SharedOpenCode2Install {
	/** The version directory, e.g. `<root>/2.0.22`. */
	directory: string;
	/** The installed package's manifest; its `version` field is what the lane trusts. */
	packageJson: string;
	/** The executable the lane spawns. */
	binary: string;
}

/** Paths inside one shared install. The directory is a plain hoisted `bun install` of `@opencode/cli`. */
export function sharedOpenCode2Install(
	version: string,
	root: string = sharedOpenCode2Root(),
): SharedOpenCode2Install {
	const directory = join(root, version);
	const cliPackage = join(directory, "node_modules/@opencode/cli");
	return {
		directory,
		packageJson: join(cliPackage, "package.json"),
		binary: join(cliPackage, "bin/opencode.exe"),
	};
}

/** Version recorded in a shared install's package manifest, or null when it is missing or unreadable. */
export function installedOpenCode2Version(
	install: SharedOpenCode2Install,
): string | null {
	try {
		const manifest = JSON.parse(readFileSync(install.packageJson, "utf8")) as {
			version?: unknown;
		};
		return typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
}

export interface ResolveOpenCode2Options {
	/** Value of MC_E2E_OPENCODE2_CLI, if any. */
	override?: string;
	/** Exact version the lane is pinned to; null skips the shared install. */
	pinnedVersion: string | null;
	/** Parent directory of the per-version shared installs. */
	sharedRoot: string;
	/** node_modules bin candidates in preference order; the first is also the fallback when none exist. */
	nodeModulesCandidates: readonly string[];
}

/**
 * Pick the CLI binary: an explicit override first, then the shared install for
 * the pinned version, then the workspace's own node_modules. A shared install
 * whose manifest reports any other version is ignored, so the lane can never
 * silently run a different host build than the one it is pinned to.
 */
export function resolveOpenCode2CLI(options: ResolveOpenCode2Options): string {
	if (options.override) {
		if (!existsSync(options.override)) {
			throw new Error(
				`MC_E2E_OPENCODE2_CLI does not exist: ${options.override}`,
			);
		}
		return resolve(options.override);
	}
	if (options.pinnedVersion) {
		const shared = sharedOpenCode2Install(
			options.pinnedVersion,
			options.sharedRoot,
		);
		if (
			existsSync(shared.binary) &&
			installedOpenCode2Version(shared) === options.pinnedVersion
		) {
			return shared.binary;
		}
	}
	const [first, ...rest] = options.nodeModulesCandidates;
	if (!first)
		throw new Error(
			"resolveOpenCode2CLI needs at least one node_modules candidate",
		);
	return [first, ...rest].find((candidate) => existsSync(candidate)) ?? first;
}
