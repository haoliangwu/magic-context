import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { loadPiConfig } from "./config/index";
import { resolveHistorianFromConfig } from "./index";

/**
 * Where a Pi session stands when the shared config puts the historian in the
 * host lane.
 *
 * The host lane is a Rust-transform arrangement: the module queues a run and a
 * host process claims it. Pi has no Rust transform mode, no module client and no
 * claim-lane caller, so nothing in a Pi session can queue a run — which means the
 * failure this pins against is not "Pi claims badly" but "a run is queued with
 * nobody to answer it". These tests state what a Pi session actually does with
 * `historian.runner: "host"`, so a later change that makes Pi queue without
 * giving it a claimant cannot land quietly.
 */

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix: string): string {
	const path = createTestTempDirFromPath(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

function withHome(home: string): void {
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
}

function writeUserConfig(home: string, text: string): void {
	const path = join(home, ".config", "cortexkit", "magic-context.jsonc");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	for (const path of tempRoots.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

/** Every non-test TypeScript source file under `packages/pi-plugin/src`. */
function piSourceFiles(): string[] {
	const root = join(import.meta.dir);
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__fixtures__" || entry.name === "fixtures")
					continue;
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".test.ts")) continue;
			found.push(path);
		}
	};
	walk(root);
	return found;
}

describe("Pi and the historian host lane", () => {
	it("runs its own historian and never queues a run for a claimant", () => {
		// A claim lane needs two halves: something that queues a run and something
		// that claims it. Pi has neither, so a Pi session cannot leave a run queued
		// with nobody to answer it, whatever the runner setting says.
		const offenders = piSourceFiles().filter((path) => {
			const source = readFileSync(path, "utf-8");
			return (
				source.includes("historian.pending") ||
				source.includes("historian.claim") ||
				source.includes("historian.heartbeat") ||
				source.includes("historian.complete")
			);
		});
		expect(offenders).toEqual([]);

		// The other half of the same fact: Pi has no Rust transform mode, so there is
		// no module for a run to be queued in.
		const rustModeCallers = piSourceFiles().filter((path) => {
			const source = readFileSync(path, "utf-8");
			return (
				source.includes("RustModeModuleClient") ||
				source.includes("createRustModeTransform")
			);
		});
		expect(rustModeCallers).toEqual([]);
	});

	it("accepts historian.runner=host in shared config and resolves the Pi subagent historian anyway", () => {
		const cwd = makeTempRoot("mc-pi-host-lane-cwd-");
		const home = makeTempRoot("mc-pi-host-lane-home-");
		withHome(home);
		writeUserConfig(
			home,
			JSON.stringify({
				transform_mode: "rust",
				historian: { runner: "host", pi: { model: "prov/historian-model" } },
			}),
		);

		const result = loadPiConfig({ cwd });
		// The schema is shared between harnesses, so the key parses here. Recorded
		// rather than approved of: it is accepted on a harness that cannot act on it,
		// and nothing tells the user that.
		expect(result.config.historian?.runner).toBe("host");
		expect(result.warnings).toEqual([]);

		const historian = resolveHistorianFromConfig(result.config);
		expect(historian).toBeDefined();
		// `PiHistorianOptions.runner` is the subagent runner Pi drives its own
		// historian through — the same object whatever `historian.runner` says. The
		// name collision is unfortunate and is worth knowing about; what matters here
		// is that the completion still happens inside the Pi session.
		expect(historian?.runner?.constructor?.name).toBe("PiSubagentRunner");
		expect(historian?.model).toBe("prov/historian-model");
	});
});
