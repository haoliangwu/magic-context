import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

for (const loss of [
	"clean restart",
	"exit before flush",
	"swallowed diagnostic write",
] as const) {
	test.skipIf(loss === "clean restart" && process.platform === "win32")(
		`review witness: ${loss === "clean restart" ? "clean restart authorizes matching busy Pi replay" : `${loss} cannot authorize stale Pi restart replay`}`,
		() => {
			const dir = createTestTempDirFromPath(
				join(tmpdir(), "pi-review-receipt-"),
			);
			const common = `
import { spyOn } from 'bun:test';
import { createFakePi, createTestDb, fakeContext, userMessage, assistantMessage } from ${JSON.stringify(join(import.meta.dir, "test-utils.test.ts"))};
import { registerPiContextHandler } from ${JSON.stringify(join(import.meta.dir, "context-handler.ts"))};
import { flushPiServedArrayLedger, __test as ledger } from ${JSON.stringify(join(import.meta.dir, "served-array-ledger.ts"))};
import * as permissions from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/shared/storage-permissions.ts"))};
import { getSlot } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/hooks/magic-context/lkg-slot.ts"))};
import { hasCleanLkgRecoveryFence } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/hooks/magic-context/lkg-recovery-fence.ts"))};
import { __test as decisions } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/features/magic-context/transform-decision-log.ts"))};
import { updateSessionMeta } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/features/magic-context/storage.ts"))};
import { Database } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/shared/sqlite.ts"))};
const dir = ${JSON.stringify(dir)};
const sessionId = 'review-lost-receipt';
const db = createTestDb(dir + '/context.db');
db.exec('PRAGMA busy_timeout=0');
const fake = createFakePi();
Object.assign(fake.pi, { getAllTools: () => [] });
registerPiContextHandler(fake.pi, { db });
const handler = fake.handlers.get('context');
const head = [userMessage('head', 1)];
const raw = [...head, assistantMessage('already served raw', 2)];
const pass = (messages, ids) => handler({ messages: structuredClone(messages) }, {
 ...fakeContext(sessionId, dir, ids, messages),
 getSystemPrompt: () => 'Complete system.',
 model: { provider: 'openai-codex', id: 'gpt-5.6-sol', contextWindow: 272000, maxTokens: 68000 }
});
`;
			const run = (code: string) => {
				const result = spawnSync(process.execPath, ["--eval", common + code], {
					env: {
						...process.env,
						MAGIC_CONTEXT_STORAGE_DIR: join(dir, "storage"),
						XDG_DATA_HOME: dir,
						BUN_JSC_useOMGJIT: "0",
					},
					encoding: "utf8",
					windowsHide: true,
					timeout: 45_000,
				});
				if (result.error) throw result.error;
				expect(result.status, result.stderr).toBe(0);
				const line = result.stdout
					.split("\n")
					.find((item) => item.startsWith("WITNESS "));
				if (!line) throw new Error(`${result.stdout}\n${result.stderr}`);
				return JSON.parse(line.slice(8)) as {
					messages: unknown[];
					trusted?: boolean;
					refused?: boolean;
					reason?: string;
					diagnosticFailures?: number;
					rawTail?: unknown;
				};
			};
			try {
				const busy = run(`
updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
const first = await pass(head, ['head']);
await new Promise(resolve => setImmediate(resolve));
flushPiServedArrayLedger();
${loss === "clean restart" ? `console.log('WITNESS ' + JSON.stringify({messages:first.messages})); process.exit(0);` : ""}
const locker = new Database(dir + '/context.db');
locker.exec('BEGIN IMMEDIATE');
const result = await pass(raw, ['head', 'tail']);
${loss === "swallowed diagnostic write" ? `spyOn(permissions, 'writeStorageFileSync').mockImplementation(() => { throw new Error('diagnostic disk failure'); }); flushPiServedArrayLedger();` : ""}
console.log('WITNESS ' + JSON.stringify({ messages: result.messages, diagnosticFailures: ledger.getDiagnostics().swallowedWriteCount }));
process.exit(0);
`);
				if (loss !== "clean restart")
					expect(JSON.stringify(busy.messages.at(-1))).toContain(
						'"text":"already served raw"',
					);
				if (loss === "swallowed diagnostic write")
					expect(busy.diagnosticFailures).toBeGreaterThan(0);
				const restarted = run(`
const slot = getSlot(sessionId);
const trusted = hasCleanLkgRecoveryFence(sessionId, slot);
const locker = new Database(dir + '/context.db');
locker.exec('BEGIN IMMEDIATE');
${loss === "clean restart" ? `const cleanReplay = await pass(raw, ['head','tail']); console.log('WITNESS ' + JSON.stringify({trusted,messages:cleanReplay.messages,rawTail:raw.at(-1)})); process.exit(0);` : ""}
let refused = false;
try { await pass(raw, ['head', 'tail']); } catch { refused = true; }
locker.exec('ROLLBACK');
const result = await pass(raw, ['head', 'tail']);
console.log('WITNESS ' + JSON.stringify({ trusted, refused, messages: result.messages, reason: decisions.getPendingPi(sessionId)?.lkgFrozenReleaseReason }));
process.exit(0);
`);
				if (loss === "clean restart") {
					expect(restarted.trusted).toBe(true);
					expect(JSON.stringify(restarted.messages)).toBe(
						JSON.stringify([...busy.messages, restarted.rawTail]),
					);
					return;
				}
				expect(restarted.trusted).toBe(false);
				expect(restarted.refused).toBe(true);
				expect(restarted.reason).toBe("lkg_restart_rebuild");
				expect(JSON.stringify(restarted.messages.at(-1))).toMatch(
					/§\d+§ already served raw/,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		90_000,
	);
}
