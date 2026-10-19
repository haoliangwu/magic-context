import { expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStallContext,
	STALL_SESSION,
} from "../../plugin/src/features/magic-context/__tests__/stall.fixture";
import { __test } from "./context-handler";

it("fallback fingerprint headers preserve ASCII LIKE matches using message index ranges", () => {
	const dir = join(
		tmpdir(),
		"magic-context",
		`fallback-prefix-${crypto.randomUUID()}`,
	);
	mkdirSync(dir, { recursive: true });
	const db = createStallContext(join(dir, "context.db"), 4096);
	try {
		const old = db
			.prepare(`SELECT DISTINCT entry_fingerprint FROM tags WHERE session_id=?
            AND type='message' AND entry_fingerprint IS NOT NULL AND message_id LIKE 'pi-msg-%'`)
			.all(STALL_SESSION) as { entry_fingerprint: string }[];
		const expected = new Set(
			old.map((row) =>
				JSON.stringify(JSON.parse(row.entry_fingerprint).slice(0, 4)),
			),
		);
		const prepare = db.prepare.bind(db);
		const plans: string[] = [];
		db.prepare = ((sql: string) => {
			const stmt = prepare(sql);
			if (!sql.includes("SELECT DISTINCT entry_fingerprint")) return stmt;
			return new Proxy(stmt, {
				get(target, prop) {
					const value = Reflect.get(target, prop);
					if (prop === "all")
						return (...args: unknown[]) => {
							plans.push(
								...(
									prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {
										detail: string;
									}[]
								).map((row) => row.detail),
							);
							return Reflect.apply(value, target, args);
						};
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}) as typeof db.prepare;
		expect(__test.readPiFallbackFingerprintHeaders(db, STALL_SESSION)).toEqual(
			expected,
		);
		expect(
			plans.some((plan) => plan.includes("message_id>? AND message_id<?")),
		).toBe(true);
		db.prepare(`INSERT INTO tags(session_id,type,tag_number,message_id,entry_fingerprint)
            VALUES (?,'message',20000,'pi-msg-invalid:p0','invalid')`).run(
			STALL_SESSION,
		);
		expect(
			__test.readPiFallbackFingerprintHeaders(db, STALL_SESSION),
		).toBeNull();
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
