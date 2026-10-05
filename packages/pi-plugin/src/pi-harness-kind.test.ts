import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import {
	__setPiHarnessKindForTesting,
	resolvePiHarnessDetection,
	resolvePiHarnessKind,
} from "./pi-harness-kind";

const originalArgv1 = process.argv[1];
const originalProcessTitle = process.title;
const temporaryRoots: string[] = [];

interface BunGlobalHost {
	launcher: string;
	hostEntry: string;
}

function temporaryRoot(): string {
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-pi-harness-kind-"));
	temporaryRoots.push(root);
	return root;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function packageHost(packageName?: string): string {
	const root = temporaryRoot();
	const hostEntry = join(root, "host.js");
	writeFileSync(hostEntry, "// fake host entry\n");
	if (packageName !== undefined) {
		writeJson(join(root, "package.json"), { name: packageName });
	}
	return hostEntry;
}

function writeEsmOnlyOmpUtils(nodeModules: string): void {
	const moduleRoot = join(nodeModules, "@oh-my-pi", "pi-utils");
	mkdirSync(join(moduleRoot, "src"), { recursive: true });
	writeJson(join(moduleRoot, "package.json"), {
		name: "@oh-my-pi/pi-utils",
		type: "module",
		exports: {
			".": {
				types: "./src/index.ts",
				import: "./src/index.ts",
			},
		},
	});
	writeFileSync(
		join(moduleRoot, "src", "index.ts"),
		'export const APP_NAME = "omp";\n',
	);
}

function bunGlobalHost(): BunGlobalHost {
	const root = temporaryRoot();
	const nodeModules = join(root, "install", "global", "node_modules");
	const hostRoot = join(nodeModules, "@oh-my-pi", "pi-coding-agent");
	const hostEntry = join(hostRoot, "dist", "cli.js");
	mkdirSync(dirname(hostEntry), { recursive: true });
	writeJson(join(hostRoot, "package.json"), {
		name: "@oh-my-pi/pi-coding-agent",
		type: "module",
	});
	writeFileSync(hostEntry, "// fake OMP CLI entry\n");
	writeEsmOnlyOmpUtils(nodeModules);

	const binDirectory = join(root, "bin");
	const launcher = join(binDirectory, "omp");
	mkdirSync(binDirectory, { recursive: true });
	symlinkSync(relative(binDirectory, hostEntry), launcher);
	return { launcher, hostEntry };
}

function esmOnlyUtilsHost(): string {
	const root = temporaryRoot();
	const hostRoot = join(root, "custom-host");
	const hostEntry = join(hostRoot, "entry.js");
	mkdirSync(hostRoot, { recursive: true });
	writeJson(join(hostRoot, "package.json"), { name: "custom-host" });
	writeFileSync(hostEntry, "// custom host entry\n");
	writeEsmOnlyOmpUtils(join(root, "node_modules"));
	return hostEntry;
}

beforeEach(() => {
	__setPiHarnessKindForTesting(undefined);
	process.title = "magic-context-test";
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	process.title = originalProcessTitle;
	if (originalArgv1 === undefined) process.argv.splice(1, 1);
	else process.argv[1] = originalArgv1;
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resolvePiHarnessDetection", () => {
	it("uses the host process title exposed before extension loading", async () => {
		process.title = "omp";
		process.argv[1] = packageHost("@earendil-works/pi-coding-agent");

		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "process-title",
		});
	});

	it("detects bun-global OMP from launcher and broker-style host argv without CJS resolution", async () => {
		const fixture = bunGlobalHost();

		expect(() =>
			createRequire(fixture.launcher).resolve("@oh-my-pi/pi-utils"),
		).toThrow();
		expect(realpathSync(fixture.launcher)).toBe(
			realpathSync(fixture.hostEntry),
		);
		expect(() =>
			createRequire(fixture.hostEntry).resolve("@oh-my-pi/pi-utils"),
		).toThrow();

		for (const argv1 of [fixture.launcher, fixture.hostEntry]) {
			__setPiHarnessKindForTesting(undefined);
			process.argv[1] = argv1;
			expect(await resolvePiHarnessDetection()).toEqual({
				kind: "omp",
				via: "package-name",
			});
		}
	});

	it("loads APP_NAME through an ESM-only export relative to the host entry", async () => {
		process.argv[1] = esmOnlyUtilsHost();

		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "app-name",
		});
	});

	it("recognizes current and legacy Pi host package names", async () => {
		for (const packageName of [
			"@earendil-works/pi-coding-agent",
			"@mariozechner/pi-coding-agent",
		]) {
			__setPiHarnessKindForTesting(undefined);
			process.argv[1] = packageHost(packageName);
			expect(await resolvePiHarnessDetection()).toEqual({
				kind: "pi",
				via: "package-name",
			});
		}
	});

	it("uses the shared executable vocabulary as the last positive rung", async () => {
		process.argv[1] = join(temporaryRoot(), "oh-my-pi");

		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "executable-name",
		});
	});

	it("falls back to Pi when no OMP identity is available", async () => {
		process.argv[1] = packageHost();

		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "pi",
			via: "default",
		});
	});

	it("memoizes the detected harness for synchronous runtime consumers", async () => {
		process.argv[1] = packageHost("@oh-my-pi/pi-coding-agent");
		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "package-name",
		});
		process.argv[1] = packageHost();

		expect(resolvePiHarnessKind()).toBe("omp");
	});
});
