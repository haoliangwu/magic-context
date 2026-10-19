import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySessionStateForClone } from "@magic-context/core/features/magic-context/storage";
import { getNativeToolInputs } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { clearContextHandlerSession } from "./context-handler";
import { calls, fixture } from "./overwall-upgrade-replay.fixture";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";

const dir = new URL("./__fixtures__/", import.meta.url);
for (const native of [false, true])
	test(`Q1 200 legacy full ${native ? "native" : "plain"} first defer equals base bytes`, async () => {
		const f = fixture(native);
		try {
			await f.seed();
			const first = await f.pass(0);
			const bytes = JSON.stringify(first);
			// Fixtures are formatted for review; these digests pin the original compact
			// handler output captured on 0ebe5b8df858, not regenerated current output.
			const baseBytes = JSON.stringify(
				JSON.parse(readFileSync(new URL(`base-${native}.json`, dir), "utf8")),
			);
			expect(createHash("sha256").update(baseBytes).digest("hex")).toBe(
				native
					? "1476e1cb61727f7534bc5d408de1b1bb872e7bb210102b06f585eddb26846e26"
					: "d29fb362f9ad71b70f1d253ef648d516bd1041b688f77649a9f9f61473396ab9",
			);
			expect(bytes).toBe(baseBytes);
			expect(calls(first)).toBe(200);
			expect(getNativeToolInputs(f.db, f.session).size).toBe(0);
			const priced = await f.pass(90);
			expect(calls(priced)).toBe(0);
			expect(getNativeToolInputs(f.db, f.session).size).toBe(200);
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(priced));
			f.restart();
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(priced));
		} finally {
			f.close();
		}
	}, 120000);
test("Q2 partial marker batch replays exactly after restart", async () => {
	const f = fixture(true, 10);
	try {
		await f.seed();
		f.db.exec(
			`CREATE TRIGGER partial BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN (SELECT count(*) FROM json_each(json_extract(NEW.trailing_blank_decisions, '$.piNative.toolInputs'))) > 5 BEGIN SELECT RAISE(FAIL,'partial failure'); END`,
		);
		const priced = await f.pass(90);
		expect(getNativeToolInputs(f.db, f.session).size).toBe(5);
		expect(calls(priced)).toBe(5);
		f.db.exec("DROP TRIGGER partial");
		f.restart();
		expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(priced));
		expect(getNativeToolInputs(f.db, f.session).size).toBe(5);
	} finally {
		f.close();
	}
});
test("Q3 cloned native markers survive remapped entry ids", async () => {
	const f = fixture(true, 10);
	try {
		await f.seed();
		const priced = await f.pass(90);
		expect(calls(priced)).toBe(0);
		const result = copySessionStateForClone(f.db, f.session, "review-clone", {
			includeTag: () => true,
			includeMessageId: () => true,
			resolveBoundaryOrdinal: () => 0,
			mapMessageId: (id) => (id.startsWith("entry-") ? `clone-${id}` : id),
			selectPendingPiMarker: () => null,
		});
		expect(result.kind).toBe("migrated");
		expect(getNativeToolInputs(f.db, "review-clone")).toEqual(
			getNativeToolInputs(f.db, f.session),
		);
		const c = fixture(true, 10, f.db, "review-clone", true);
		const deferred = await c.pass(0);
		expect(calls(deferred)).toBe(0);
		expect(JSON.stringify(deferred)).toBe(JSON.stringify(priced));
		clearContextHandlerSession("review-clone");
	} finally {
		f.close();
	}
});

test("Q2 malformed document after mint retains pairs on restart defer", async () => {
	const f = fixture(true, 10);
	const publication = observePiPublicationForTest(f.session);
	try {
		await f.seed();
		expect(calls(await f.pass(90))).toBe(0);
		f.db
			.prepare(
				"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
			)
			.run("{", f.session);
		f.restart();
		publication.reset();
		const deferred = await f.pass(0);
		expect(calls(deferred)).toBe(10);
		expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(deferred));
		publication.expect("skipped", "envelope_unreadable", 2);
		expect(
			f.db
				.prepare(
					"SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?",
				)
				.get(f.session),
		).toEqual({ trailing_blank_decisions: "{" });
	} finally {
		publication.restore();
		f.close();
	}
});
test("Q3 Pi filter with remapped entries does not inherit source authorization", async () => {
	const { __test } = await import("./clone-inheritance");
	const f = fixture(true, 10);
	try {
		await f.seed();
		await f.pass(90);
		const entries = f.source.map((message, index) => ({
			type: "message",
			id: `clone-entry-${index}`,
			parentId: index ? `clone-entry-${index - 1}` : null,
			message,
		}));
		const copied = copySessionStateForClone(
			f.db,
			f.session,
			"review-pi-remap",
			__test.createCloneFilter(entries),
		);
		expect(copied.tagsCopied).toBe(0);
		expect(getNativeToolInputs(f.db, "review-pi-remap").size).toBe(0);
		const c = fixture(true, 10, f.db, "review-pi-remap", true);
		expect(calls(await c.pass(0))).toBe(10);
		clearContextHandlerSession("review-pi-remap");
	} finally {
		f.close();
	}
});

for (const native of [false, true]) {
	test(`identity-preserving Pi forks inherit removal markers (native=${native})`, async () => {
		const { __test } = await import("./clone-inheritance");
		const f = fixture(native, 10);
		const cloneSession = `identity-clone-${native}`;
		try {
			await f.seed();
			const priced = await f.pass(90);
			expect(calls(priced)).toBe(0);
			const entries = f.source.map((message, index) => ({
				type: "message",
				id: f.ids[index],
				parentId: index ? f.ids[index - 1] : null,
				message,
			}));
			const copied = copySessionStateForClone(
				f.db,
				f.session,
				cloneSession,
				__test.createCloneFilter(entries),
			);
			expect(copied.kind).toBe("migrated");
			expect(getNativeToolInputs(f.db, cloneSession)).toEqual(
				getNativeToolInputs(f.db, f.session),
			);
			const clone = fixture(native, 10, f.db, cloneSession);
			expect(JSON.stringify(await clone.pass(0))).toBe(JSON.stringify(priced));
		} finally {
			clearContextHandlerSession(cloneSession);
			f.close();
		}
	});
}

// Both phases use fresh processes; replay starts only after mint has closed its database.

for (const native of [false, true]) {
	test(`removal markers survive a separate-process restart (native=${native})`, async () => {
		const root = createTestTempDirFromPath(
			join(tmpdir(), "mc-overwall-restart-"),
		);
		try {
			for (const mode of ["mint", "replay"]) {
				const child = Bun.spawn({
					windowsHide: true,
					cmd: [
						process.execPath,
						new URL("./overwall-restart-child.fixture.ts", import.meta.url)
							.pathname,
					],
					cwd: process.cwd(),
					env: {
						...process.env,
						MC_OVERWALL_RESTART_MODE: mode,
						MC_OVERWALL_RESTART_DIR: root,
						MC_OVERWALL_RESTART_NATIVE: String(native),
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 30000,
				});
				const ready = Promise.withResolvers<void>();
				const stderr = new Response(child.stderr).text();
				let output = "";
				const decoder = new TextDecoder();
				const read = child.stdout.pipeTo(
					new WritableStream({
						write(chunk) {
							output += decoder.decode(chunk, { stream: true });
							if (output.split("\n").includes(`READY ${mode}`)) ready.resolve();
						},
					}),
				);
				try {
					await Promise.race([
						ready.promise,
						child.exited.then(async (code) => {
							throw new Error(
								`${mode} child exited before READY (${code}): ${await stderr}`,
							);
						}),
					]);
					child.stdin.write("GO\n");
					child.stdin.end();
					const code = await child.exited;
					await read;
					expect(code, `${mode} child: ${await stderr}`).toBe(0);
					expect(
						output.split("\n"),
						`${mode} child did not complete`,
					).toContain(`DONE ${mode}`);
					const result = JSON.parse(
						readFileSync(join(root, `${mode}.json`), "utf8"),
					);
					expect(calls(result.messages)).toBe(0);
					expect(result.markers).toHaveLength(10);
					expect(
						result.markers.every(
							([, value]: [string, string]) =>
								value === '{"__magic_context_remove_tool_arc__":true}',
						),
					).toBe(true);
				} finally {
					if (child.exitCode === null) child.kill();
					await child.exited;
					await read;
				}
			}
			expect(readFileSync(join(root, "replay.json"), "utf8")).toBe(
				readFileSync(join(root, "mint.json"), "utf8"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120000);
}
