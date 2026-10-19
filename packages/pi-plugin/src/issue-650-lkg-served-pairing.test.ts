import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPersistedLkgSlot } from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import * as storagePermissions from "@magic-context/core/shared/storage-permissions";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	flushPiServedArrayLedger,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

for (const overrun of [false, true]) {
	test(
		overrun
			? "does not orphan durable served numbers when identity append overruns the Pi publication budget"
			: "pairs a completed real Pi pass with its served numbers and LKG",
		async () => {
			const { dir: root, cleanup } = createTestTempDir("pi-served-lkg-pair-");
			const priorDataHome = process.env.XDG_DATA_HOME;
			const priorConfigHome = process.env.XDG_CONFIG_HOME;
			process.env.XDG_DATA_HOME = root;
			process.env.XDG_CONFIG_HOME = root;
			const db = createTestDb(join(root, "context.db"));
			const sessionId = `pi-served-lkg-pair-${overrun}`;
			const storageDir = getMagicContextStorageDir();
			const identityPath = getPiServedTagNumbersPath(sessionId, storageDir);
			let now = 0;
			let identityWrites = 0;
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			const write = storagePermissions.writeStorageFileSync;
			const writer = spyOn(
				storagePermissions,
				"writeStorageFileSync",
			).mockImplementation((path, content, options) => {
				write(path, content, options);
				if (path === identityPath) {
					identityWrites++;
					// A synchronous filesystem call cannot be preempted by the budget.
					// Advance its clock only after the real append has reached disk.
					if (overrun) now = 26_000;
				}
			});
			try {
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, { db });
				const handler = fake.handlers.get("context");
				if (!handler) throw new Error("context handler missing");
				const raw = [userMessage("pair this served request", 1)];
				const ctx = fakeContext(sessionId, root, ["entry-1"], raw);
				const pending = handler({ messages: raw } as never, ctx as never);
				let served: { messages: unknown[] } | undefined;
				if (overrun) {
					await expect(pending).rejects.toThrow(
						"stage=LKG/served publication elapsed=26000ms",
					);
				} else {
					served = (await pending) as { messages: unknown[] };
					expect(JSON.stringify(served.messages)).toContain("§1§");
				}
				expect(identityWrites).toBe(1);
				await new Promise<void>((resolve) => setImmediate(resolve));
				flushPiServedArrayLedger();
				const slot = getInMemorySlot(sessionId);
				const durableSlot = loadPersistedLkgSlot(db, sessionId);
				if (overrun) {
					expect(
						existsSync(getPiServedArrayLedgerPath(sessionId, storageDir)),
					).toBe(false);
				} else {
					expect(slot?.jsonPrefix).toBe(JSON.stringify(served?.messages));
				}
				// Clear the served cache before reading: the invariant concerns durable
				// identity, not merely the set a successful handler keeps in memory.
				clearContextHandlerSession(sessionId);
				const persistedNumbers: number[] = existsSync(identityPath)
					? JSON.parse(readFileSync(identityPath, "utf8")).tag_numbers
					: [];
				expect([...getPiServedTagNumbers(sessionId, storageDir)]).toEqual(
					persistedNumbers,
				);
				if (!overrun) expect(persistedNumbers).toEqual([1]);
				// Either neither publication survived, or the actual numbered request
				// is recoverable. A digest-only telemetry row is not an LKG.
				if (persistedNumbers.length > 0) {
					expect(slot).toBeDefined();
					expect(durableSlot?.jsonPrefix).toBe(slot?.jsonPrefix);
					expect(slot?.inputIdSeq).toEqual(["entry-1"]);
					expect(slot?.jsonPrefix).toContain("§1§ pair this served request");
				}
			} finally {
				writer.mockRestore();
				clock.mockRestore();
				clearContextHandlerSession(sessionId);
				resetLkgSlotsForTest();
				db.close();
				if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
				else process.env.XDG_DATA_HOME = priorDataHome;
				if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
				else process.env.XDG_CONFIG_HOME = priorConfigHome;
				cleanup();
			}
		},
	);
}
