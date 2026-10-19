import { expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_TTL_MS,
} from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";

for (const phase of ["provider", "before-commit", "after-commit"]) {
	it(`headless historian SIGKILL at ${phase} leaves atomic publication and a reclaimable lease`, async () => {
		const { dir: root, cleanup } = createTestTempDir("pi-historian-crash-");
		const path = join(root, "context.db");
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			HOME: root,
			TMPDIR: root,
			NODE_ENV: "test",
		};
		for (const key of [
			"XDG_DATA_HOME",
			"XDG_CONFIG_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"XDG_RUNTIME_DIR",
			"MAGIC_CONTEXT_STORAGE_DIR",
			"PI_CODING_AGENT_DIR",
		]) {
			const directory = join(root, key);
			env[key] = directory;
			mkdirSync(directory);
		}
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "fixtures/historian-crash.ts"),
				path,
				phase,
			],
			{ env, stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		const stderr = new Response(child.stderr).text();
		const reader = child.stdout.getReader();
		const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
		let db: Database | undefined;
		try {
			const output = new TextDecoder().decode((await reader.read()).value);
			if (!output) throw new Error(await stderr);
			expect(output).toContain(
				phase === "provider"
					? "PROVIDER_STARTED"
					: phase === "before-commit"
						? "BEFORE_COMMIT"
						: "AFTER_COMMIT",
			);
			child.kill("SIGKILL");
			await child.exited;
			expect(await stderr).not.toContain("Error:");
			db = new Database(path);
			const compartments = getCompartments(db, "crash-historian");
			expect(compartments.length).toBe(phase === "after-commit" ? 1 : 0);
			expect(
				getPendingPiCompactionMarkerState(db, "crash-historian") !== null,
			).toBe(phase === "after-commit");
			expect(getPendingOps(db, "crash-historian").length > 0).toBe(
				phase === "after-commit",
			);
			expect(
				getOrCreateSessionMeta(db, "crash-historian").compartmentInProgress,
			).toBe(true);
			const lease = db
				.prepare(
					"SELECT owner_pid, expires_at FROM compartment_state_lease WHERE session_id = ?",
				)
				.get("crash-historian") as { owner_pid: number; expires_at: number };
			expect(lease.owner_pid).toBe(child.pid);
			expect(lease.expires_at - Date.now()).toBeLessThanOrEqual(
				COMPARTMENT_LEASE_TTL_MS,
			);
			// If checking whether the old PID is alive is denied by the OS, the
			// expired lease still lets another historian acquire publication rights.
			db.prepare("UPDATE compartment_state_lease SET expires_at = 0").run();
			expect(
				acquireCompartmentLease(db, "crash-historian", "recovered-holder")
					?.ownerPid,
			).toBe(process.pid);
			expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
				integrity_check: "ok",
			});
		} finally {
			clearTimeout(timer);
			child.kill("SIGKILL");
			await child.exited;
			db?.close();
			cleanup();
		}
	}, 20000);
}
