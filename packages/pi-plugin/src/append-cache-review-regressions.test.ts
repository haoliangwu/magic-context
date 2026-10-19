import { Database as UnwrappedDatabase } from "bun:sqlite";
import { expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { clearSession } from "@magic-context/core/features/magic-context/storage-meta-session";
import {
	tagIdentityRevisionKey,
	tagRevisionKey,
	tagTombstoneOwnerRange,
} from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	getMaxTagNumberByOwnerMessage,
	getReasoningTokenEstimatesByMessage,
	getTagsBySession,
	markWhitespaceAssistantTagInert,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	type MessageLike,
	tagMessages,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { prewarmTagOwners } from "@magic-context/core/hooks/magic-context/tag-owner-warmup";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { __test as contextTest } from "./context-handler";
import { createPiFallbackIndex } from "./pi-fallback-index";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import { createPiTagSnapshotReader } from "./tag-snapshot-pi";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";

function harness() {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-append-review-"));
	const path = join(root, "context.db");
	const local = new Database(path);
	initializeDatabase(local);
	runMigrations(local);
	const foreign = Array.from({ length: 3 }, () => {
		const db = new Database(path);
		initializeDatabase(db);
		return db;
	});
	return {
		local,
		foreign,
		path,
		close() {
			for (const db of [local, ...foreign]) db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function insert(
	db: Database,
	session: string,
	number: number,
	text: string,
	status = "active",
) {
	db.prepare(
		"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size, harness) VALUES (?, ?, 'message', ?, ?, ?, 'pi')",
	).run(session, text, status, number, text.length);
}
function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("missing reproduction fixture value");
	return value;
}

function rng(seed: number) {
	return () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed >>> 0;
	};
}

it("review randomized snapshot equals full reload after 15000 mixed initialized-writer operations", () => {
	const counts = { clear: 0, recreate: 0, replace: 0 };
	for (const seed of [0x650, 0xcafe, 0x5eed]) {
		const h = harness();
		const read = createPiTagSnapshotReader(h.local);
		const random = rng(seed);
		const sessions = ["session", "clone", "elsewhere"];
		let serial = 0;
		try {
			for (let step = 0; step < 5000; step++) {
				const db = required([h.local, ...h.foreign][random() % 4]);
				const session = required(sessions[random() % 3]);
				const rows = getTagsBySession(h.local, session);
				const row = rows[random() % Math.max(1, rows.length)];
				const operation = random() % 15;
				const perform = () => {
					if (!row || operation === 0) {
						insert(db, session, ++serial, `m-${serial}`);
					} else if (operation === 1) {
						db.prepare(
							"UPDATE tags SET status = ?, drop_mode = ? WHERE id = ?",
						).run(
							random() % 2 ? "dropped" : "active",
							random() % 2 ? "skeleton_real" : "full",
							row.id,
						);
					} else if (operation === 2) {
						db.prepare(
							"UPDATE tags SET byte_size=?, input_byte_size=?, reasoning_byte_size=?, token_count=?, input_token_count=?, reasoning_token_count=? WHERE id=?",
						).run(
							random() % 10000,
							random() % 1000,
							random() % 1000,
							random() % 500,
							random() % 100,
							random() % 100,
							row.id,
						);
					} else if (operation === 3) {
						db.prepare("DELETE FROM tags WHERE id=?").run(row.id);
					} else if (operation === 4) {
						db.prepare(
							"UPDATE tags SET message_id=?, tag_number=? WHERE id=?",
						).run(`renamed-${++serial}`, serial, row.id);
					} else if (operation === 5) {
						db.prepare(
							"UPDATE tags SET session_id=?, tag_number=? WHERE id=?",
						).run(
							sessions[(sessions.indexOf(session) + 1) % 3],
							++serial,
							row.id,
						);
					} else if (operation === 6) {
						db.prepare(
							"UPDATE tags SET tool_owner_message_id=?, type='tool', tool_name='bash', entry_fingerprint=? WHERE id=?",
						).run(`owner-${++serial}`, `fp-${serial}`, row.id);
					} else if (operation === 7) {
						db.prepare(
							"UPDATE tags SET status='compacted' WHERE session_id=?",
						).run(session);
					} else if (operation === 8) {
						db.prepare(
							"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) SELECT ?, message_id || ?,type,status,?,byte_size,harness FROM tags WHERE id=?",
						).run(
							sessions[(sessions.indexOf(session) + 1) % 3],
							`-clone-${++serial}`,
							serial,
							row.id,
						);
					} else if (operation === 9) {
						db.prepare("UPDATE tags SET status='dropped' WHERE id=?").run(
							row.id,
						);
						db.prepare(
							"UPDATE tags SET status='active', byte_size=17 WHERE id=?",
						).run(row.id);
					} else if (operation === 10) {
						db.prepare(
							"INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('review-metadata',?)",
						).run(String(step));
					} else if (operation === 11) {
						db.prepare("DELETE FROM tags WHERE session_id=?").run(session);
					} else if (operation === 12 || operation === 13) {
						clearSession(db, session);
						counts.clear++;
						if (operation === 13) {
							insert(db, session, ++serial, `recreated-${serial}`, "dropped");
							counts.recreate++;
						}
					} else {
						const target =
							random() % 2
								? session
								: sessions[(sessions.indexOf(session) + 1) % 3];
						db.prepare(
							"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, ?, ?, 'message', 'dropped', ?, 19, 'pi')",
						).run(row.id, target, `replaced-${++serial}`, serial);
						counts.replace++;
					}
				};
				if (random() % 5 === 0) {
					db.exec("BEGIN");
					perform();
					if (db === h.local)
						for (const s of sessions)
							expect(JSON.stringify(read(s))).toBe(
								JSON.stringify(getTagsBySession(h.local, s)),
							);
					db.exec(random() % 2 ? "COMMIT" : "ROLLBACK");
				} else perform();
				for (const s of sessions) {
					expect(
						JSON.stringify(read(s)),
						`seed=${seed} step=${step} operation=${operation} session=${s}`,
					).toBe(JSON.stringify(getTagsBySession(h.local, s)));
				}
			}
		} finally {
			h.close();
		}
	}
	for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);
	console.log(
		`Pi snapshot differential: 15000 operations, three seeds, four initialized connections; ${JSON.stringify(counts)}`,
	);
}, 120000);

it("review initialized foreign clear and recreate must not alias a cached revision", () => {
	const h = harness();
	try {
		insert(required(h.foreign[0]), "session", 1, "before", "active");
		const read = createPiTagSnapshotReader(h.local);
		expect(read("session")[0]?.messageId).toBe("before");
		clearSession(required(h.foreign[0]), "session");
		insert(required(h.foreign[0]), "session", 7, "after", "dropped");
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
	} finally {
		h.close();
	}
});

it("known limit: uninitialized foreign writes stay stale until a recognized session change or reopen", () => {
	const h = harness();
	const raw = new Database(h.path);
	try {
		insert(h.local, "session", 1, "original");
		const read = createPiTagSnapshotReader(h.local);
		read("session");
		raw
			.prepare(
				"UPDATE tags SET status='dropped', drop_mode='skeleton_real' WHERE session_id='session'",
			)
			.run();
		expect(read("session")[0]?.status).toBe("active");
		expect(getTagsBySession(h.local, "session")[0]?.status).toBe("dropped");
		insert(required(h.foreign[0]), "session", 2, "recognized");
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
		raw
			.prepare(
				"UPDATE tags SET status='active' WHERE tag_number=1 AND session_id='session'",
			)
			.run();
		expect(read("session")[0]?.status).toBe("dropped");
		const reopened = new Database(h.path);
		initializeDatabase(reopened);
		try {
			const prepare = spyOn(reopened, "prepare");
			try {
				expect(createPiTagSnapshotReader(reopened)("session")).toEqual(
					getTagsBySession(h.local, "session"),
				);
				expect(
					prepare.mock.calls.some(
						([sql]) =>
							sql.includes("FROM tags WHERE session_id") &&
							!sql.includes("tag_number IN"),
					),
				).toBe(true);
			} finally {
				prepare.mockRestore();
			}
		} finally {
			reopened.close();
		}
	} finally {
		raw.close();
		h.close();
	}
});

type Msg = {
	id: string;
	role: string;
	timestamp: number;
	content: {
		type: string;
		id: string;
		name: string;
		arguments: { nested: { query: string } };
	}[];
};
function fallback(
	index: ReturnType<typeof createPiFallbackIndex>,
	messages: Msg[],
) {
	return index.update({
		messages,
		resolveId: (m) => m.id,
		header: (m) => String(m.timestamp),
		fingerprint: piMessageEntryFingerprint,
		toolOwners: (m, id) =>
			new Map(
				m.content
					.filter((p) => p.type === "toolCall")
					.map((p) => [p.id, new Set([id])]),
			),
		reusable: new Set(messages.map((m) => m.id)),
	});
}
function msg(id: string, text = "alpha"): Msg {
	return {
		id,
		role: "assistant",
		timestamp: 123,
		content: [
			{
				type: "toolCall",
				id: "shared",
				name: "bash",
				arguments: { nested: { query: text } },
			},
		],
	};
}
it("review nested tool argument extension rewrite matches a cold fallback index", () => {
	const index = createPiFallbackIndex();
	fallback(index, [msg("one"), msg("two")]);
	const rewritten = [msg("one"), msg("two", "bravo")];
	const incremental = fallback(index, rewritten);
	const cold = fallback(createPiFallbackIndex(), rewritten);
	expect(incremental.changedFrom).toBe(1);
	expect(incremental.fingerprints(null)).toEqual(cold.fingerprints(null));
	expect(incremental.owners).toEqual(cold.owners);
	expect(incremental.positions).toEqual(cold.positions);
});
it("review removing a duplicate stable ID preserves surviving fallback owner and position", () => {
	const index = createPiFallbackIndex();
	fallback(index, [msg("same"), msg("same")]);
	const current = [msg("same")];
	const incremental = fallback(index, current);
	const cold = fallback(createPiFallbackIndex(), current);
	expect(incremental.fingerprints(null)).toEqual(cold.fingerprints(null));
	expect(incremental.owners).toEqual(cold.owners);
	expect(incremental.positions).toEqual(cold.positions);
});

function hygieneTag(number: number, status: TagEntry["status"]): TagEntry {
	return Object.freeze({
		tagNumber: number,
		messageId: "user:p0",
		type: "message",
		status,
		dropMode: "full",
		toolName: null,
		inputByteSize: 0,
		byteSize: 1,
		reasoningByteSize: 0,
		sessionId: "session",
		cavemanDepth: 0,
		toolOwnerMessageId: null,
	});
}
it("review hygiene transition to a lower-number duplicate key retains canonical last-row-wins", () => {
	const key = {};
	const high = hygieneTag(10, "active");
	const input = {
		messages: [{ role: "user", content: "unprefixed extension rewrite" }],
		protectedTagNumbers: new Set<number>(),
		stableId: () => "user",
	};
	measurePiTailHygiene({
		...input,
		tags: Object.freeze([high]),
		tagCacheKey: key,
	});
	const tags = Object.freeze([hygieneTag(1, "dropped"), high]);
	expect(measurePiTailHygiene({ ...input, tags, tagCacheKey: key })).toEqual(
		measurePiTailHygiene({ ...input, tags }),
	);
});

for (const writer of ["local", "foreign"] as const) {
	it(`review initialized ${writer} REPLACE renumber must remove the old snapshot row`, () => {
		const h = harness();
		try {
			insert(h.local, "session", 1, "original");
			const read = createPiTagSnapshotReader(h.local);
			const old = required(read("session")[0]);
			const db = writer === "local" ? h.local : required(h.foreign[0]);
			db.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'session', 'replacement', 'message', 'dropped', 7, 11, 'pi')",
			).run(old.id);
			expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
		} finally {
			h.close();
		}
	});
}

it("review initialized foreign REPLACE session move invalidates the old session", () => {
	const h = harness();
	try {
		insert(h.local, "session", 1, "original");
		const read = createPiTagSnapshotReader(h.local);
		const old = required(read("session")[0]);
		required(h.foreign[0])
			.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'clone', 'moved', 'message', 'dropped', 7, 5, 'pi')",
			)
			.run(old.id);
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
		expect(read("clone")).toEqual(getTagsBySession(h.local, "clone"));
	} finally {
		h.close();
	}
});

it("full-row session revisions survive repeated clear/recreate and readers notice a lower restored stamp", () => {
	const h = harness();
	try {
		const writer = required(h.foreign[0]);
		const revision = () => {
			const stored = (
				writer
					.prepare(
						"SELECT value FROM schema_migrations_meta WHERE key='tag_revision:session'",
					)
					.get() as { value: string } | null
			)?.value;
			return Number(stored?.split(":").at(-1) ?? 0);
		};
		const read = createPiTagSnapshotReader(h.local);
		let previous = revision();
		for (let cycle = 0; cycle < 8; cycle++) {
			insert(writer, "session", cycle + 1, `cycle-${cycle}`);
			expect(revision()).toBeGreaterThan(previous);
			previous = revision();
			read("session");
			clearSession(writer, "session");
			expect(revision()).toBeGreaterThan(previous);
			previous = revision();
		}
		insert(writer, "session", 10, "restored");
		read("session");
		writer
			.prepare("UPDATE tags SET status='dropped' WHERE session_id='session'")
			.run();
		writer
			.prepare(
				"UPDATE schema_migrations_meta SET value='0' WHERE key='tag_revision:session'",
			)
			.run();
		expect(read("session")[0]?.status).toBe("dropped");
	} finally {
		h.close();
	}
});

for (const recursive of [false, true]) {
	for (const writer of ["local", "foreign"] as const) {
		it(`REPLACE journals every primary/number/owned-tool conflict for ${writer} writes with recursive triggers ${recursive}`, () => {
			const h = harness();
			try {
				const db = writer === "local" ? h.local : required(h.foreign[0]);
				db.exec(`PRAGMA recursive_triggers=${recursive ? "ON" : "OFF"}`);
				insert(h.local, "session", 1, "primary-key-victim");
				insert(h.local, "clone", 7, "number-victim");
				h.local
					.prepare(
						"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES ('clone','call','tool','active',9,0,'pi','owner')",
					)
					.run();
				const read = createPiTagSnapshotReader(h.local);
				const old = required(read("session")[0]);
				read("clone");
				db.prepare(
					"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES (?, 'clone','call','tool','dropped',7,19,'pi','owner')",
				).run(old.id);
				expect(read("session")).toEqual([]);
				expect(read("clone")).toEqual(getTagsBySession(h.local, "clone"));
				expect(read("clone")).toHaveLength(1);
				expect(db.prepare("PRAGMA recursive_triggers").get()).toEqual({
					recursive_triggers: recursive ? 1 : 0,
				});
				h.local.exec("BEGIN");
				h.local
					.prepare(
						"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'session','rollback','message','active',12,0,'pi')",
					)
					.run(old.id);
				expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
				h.local.exec("ROLLBACK");
				expect(read("session")).toEqual([]);
				expect(read("clone")).toEqual(getTagsBySession(h.local, "clone"));
			} finally {
				h.close();
			}
		});
	}
}

for (const floor of [0, 1]) {
	it(`foreign REPLACE invalidates warm tagger assignments at unchanged floor ${floor}`, () => {
		const h = harness();
		const tagger = createTagger();
		try {
			const anchor = tagger.assignTag(
				"session",
				"anchor",
				"message",
				6,
				h.local,
			);
			const original = tagger.assignTag(
				"session",
				"original",
				"message",
				8,
				h.local,
			);
			tagger.initFromDb("session", h.local, floor);
			const oldVersion = tagger.getLoadedTagsVersion?.("session", h.local);
			expect(tagger.getTag("session", "original", "message")).toBe(original);
			const row = required(
				getTagsBySession(h.local, "session").find(
					(tag) => tag.tagNumber === original,
				),
			);
			required(h.foreign[0])
				.prepare(
					"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'clone','moved','message','dropped',7,5,'pi')",
				)
				.run(row.id);
			tagger.initFromDb("session", h.local, floor);
			expect(tagger.getTag("session", "anchor", "message")).toBe(anchor);
			expect(tagger.getTag("session", "original", "message")).toBeUndefined();
			expect(tagger.getLoadedTagsVersion?.("session", h.local)).not.toBe(
				oldVersion,
			);
			const assigned = tagger.assignTag(
				"session",
				"original",
				"message",
				8,
				h.local,
			);
			expect(assigned).toBeGreaterThan(original);
			expect(
				getTagsBySession(h.local, "session").find(
					(tag) => tag.messageId === "original",
				)?.tagNumber,
			).toBe(assigned);
		} finally {
			tagger.cleanup("session");
			h.close();
		}
	});
}

it("foreign REPLACE invalidates cached fallback call IDs in the removed session", () => {
	const h = harness();
	const originalPrepare = h.local.prepare.bind(h.local);
	let ownerLookups = 0;
	const prepare = spyOn(h.local, "prepare").mockImplementation((sql) => {
		const statement = originalPrepare(sql);
		if (sql.includes("tool_owner_message_id AS owner")) {
			return new Proxy(statement, {
				get(target, property) {
					if (property === "all")
						return (...params: unknown[]) => {
							ownerLookups++;
							return target.all(...params);
						};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}
		return statement;
	});
	try {
		h.local
			.prepare(
				"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES ('session','shared','tool','active',1,0,'pi','pi-msg-0-123-assistant')",
			)
			.run();
		const messages = [msg("real-owner")] as unknown as Parameters<
			typeof contextTest.guardPiToolAllocations
		>[2];
		expect(
			contextTest.guardPiToolAllocations(
				h.local,
				"session",
				messages,
				() => "real-owner",
			),
		).toHaveLength(1);
		expect(ownerLookups).toBe(1);
		const row = required(getTagsBySession(h.local, "session")[0]);
		required(h.foreign[0])
			.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'clone','moved','message','dropped',7,5,'pi')",
			)
			.run(row.id);
		ownerLookups = 0;
		expect(
			contextTest.guardPiToolAllocations(
				h.local,
				"session",
				messages,
				() => "real-owner",
			),
		).toEqual([]);
		expect(ownerLookups).toBe(0);
	} finally {
		prepare.mockRestore();
		h.close();
	}
});

it("foreign REPLACE invalidates cached inert-whitespace replay in the removed session", () => {
	const h = harness();
	const tagger = createTagger();
	const originalPrepare = h.local.prepare.bind(h.local);
	let inertReads = 0;
	const prepare = spyOn(h.local, "prepare").mockImplementation((sql) => {
		const statement = originalPrepare(sql);
		if (!sql.includes("FROM json_each(?) AS owners CROSS JOIN tags"))
			return statement;
		return new Proxy(statement, {
			get(target, property) {
				if (property === "all")
					return (...params: unknown[]) => {
						inertReads++;
						return target.all(...params);
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
	const render = () => {
		const part = { type: "text", text: " " };
		const message: MessageLike = {
			info: { id: "assistant-blank", role: "assistant", sessionID: "session" },
			parts: [part],
		};
		tagMessages("session", [message], tagger, h.local);
		return part.text;
	};
	try {
		insert(h.local, "session", 1, "assistant-blank:p0");
		markWhitespaceAssistantTagInert(
			h.local,
			"session",
			1,
			"assistant-blank:p0",
		);
		tagger.initFromDb("session", h.local);
		expect(render()).toBe("§1§  ");
		expect(inertReads).toBe(1);
		const row = required(getTagsBySession(h.local, "session")[0]);
		required(h.foreign[0])
			.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'clone','moved','message','dropped',7,5,'pi')",
			)
			.run(row.id);
		inertReads = 0;
		tagger.initFromDb("session", h.local);
		expect(render()).toBe(" ");
		// The row-existence guard can suppress a stale prefix by itself. Check
		// the cached projection was refreshed too, rather than merely rejected later.
		expect(inertReads).toBe(1);
		expect(getTagsBySession(h.local, "session")).toEqual([]);
	} finally {
		prepare.mockRestore();
		tagger.cleanup("session");
		h.close();
	}
});

it("owner summary observes REPLACE identity/reasoning changes with preserved count and primary ID", async () => {
	const h = harness();
	// Bypass this process's JS write-generation hooks, as a different process
	// would, while installing the same SQLite triggers on its connection.
	const writer = new UnwrappedDatabase(h.path);
	initializeDatabase(writer as unknown as Database);
	try {
		insert(h.local, "session", 1, "before:p0");
		h.local
			.prepare(
				"UPDATE tags SET reasoning_token_count=4 WHERE session_id='session'",
			)
			.run();
		expect(await prewarmTagOwners(h.local, "session", 1)).toBe(true);
		expect(new Map(getMaxTagNumberByOwnerMessage(h.local, "session"))).toEqual(
			new Map([["before", 1]]),
		);
		expect(
			new Map(getReasoningTokenEstimatesByMessage(h.local, "session", 1)),
		).toEqual(new Map([["before", 4]]));
		const row = required(getTagsBySession(h.local, "session")[0]);
		writer
			.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness,reasoning_token_count) VALUES (?, 'session','after:p0','message','active',1,5,'pi',20)",
			)
			.run(row.id);
		expect(await prewarmTagOwners(h.local, "session", 1)).toBe(true);
		expect(new Map(getMaxTagNumberByOwnerMessage(h.local, "session"))).toEqual(
			new Map([["after", 1]]),
		);
		expect(
			new Map(getReasoningTokenEstimatesByMessage(h.local, "session", 1)),
		).toEqual(new Map([["after", 20]]));
	} finally {
		writer.close();
		h.close();
	}
});

it("clear and recreate cannot alias a warm tagger at the same tags_version and floor", () => {
	const h = harness();
	const tagger = createTagger();
	try {
		tagger.assignTag("session", "anchor", "message", 6, h.local);
		tagger.assignTag("session", "original", "message", 8, h.local);
		tagger.initFromDb("session", h.local, 1);
		const version = tagger.getLoadedTagsVersion?.("session", h.local);
		clearSession(required(h.foreign[0]), "session");
		insert(required(h.foreign[0]), "session", 1, "anchor");
		insert(required(h.foreign[0]), "session", 7, "original", "dropped");
		tagger.initFromDb("session", h.local, 1);
		expect(tagger.getLoadedTagsVersion?.("session", h.local)).toBe(version);
		expect(tagger.getTag("session", "original", "message")).toBe(7);
	} finally {
		tagger.cleanup("session");
		h.close();
	}
});

it("clear and recreate refreshes inert-whitespace replay even when tags_version repeats", () => {
	const h = harness();
	const tagger = createTagger();
	const render = () => {
		const part = { type: "text", text: " " };
		const message: MessageLike = {
			info: { id: "assistant-blank", role: "assistant", sessionID: "session" },
			parts: [part],
		};
		tagMessages("session", [message], tagger, h.local);
		return part.text;
	};
	try {
		insert(h.local, "session", 1, "assistant-blank:p0");
		markWhitespaceAssistantTagInert(
			h.local,
			"session",
			1,
			"assistant-blank:p0",
		);
		tagger.initFromDb("session", h.local);
		expect(render()).toBe("§1§  ");
		const version = tagger.getLoadedTagsVersion?.("session", h.local);
		clearSession(required(h.foreign[0]), "session");
		insert(required(h.foreign[0]), "session", 7, "assistant-blank:p0");
		markWhitespaceAssistantTagInert(
			required(h.foreign[0]),
			"session",
			7,
			"assistant-blank:p0",
		);
		tagger.initFromDb("session", h.local);
		expect(tagger.getLoadedTagsVersion?.("session", h.local)).toBe(version);
		expect(render()).toBe("§7§  ");
	} finally {
		tagger.cleanup("session");
		h.close();
	}
});

it("clear and recreate cannot alias the owner summary after explicit primary-ID reimport", async () => {
	const h = harness();
	const writer = new UnwrappedDatabase(h.path);
	initializeDatabase(writer as unknown as Database);
	try {
		insert(h.local, "session", 1, "before:p0");
		h.local
			.prepare(
				"UPDATE tags SET reasoning_token_count=4 WHERE session_id='session'",
			)
			.run();
		expect(await prewarmTagOwners(h.local, "session", 1)).toBe(true);
		const row = required(getTagsBySession(h.local, "session")[0]);
		clearSession(writer as unknown as Database, "session");
		writer
			.prepare(
				"INSERT INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'session','after:p0','message','active',1,5,'pi')",
			)
			.run(row.id);
		writer
			.prepare(
				"UPDATE tags SET reasoning_token_count=20 WHERE session_id='session'",
			)
			.run();
		expect(await prewarmTagOwners(h.local, "session", 1)).toBe(true);
		expect(new Map(getMaxTagNumberByOwnerMessage(h.local, "session"))).toEqual(
			new Map([["after", 1]]),
		);
		expect(
			new Map(getReasoningTokenEstimatesByMessage(h.local, "session", 1)),
		).toEqual(new Map([["after", 20]]));
	} finally {
		writer.close();
		h.close();
	}
});

it("permanent session deletion retires identity/full epochs and owner provenance", () => {
	const h = harness();
	const rows = () =>
		h.local
			.prepare(
				"SELECT key FROM schema_migrations_meta WHERE key IN (?, ?) OR (key >= ? AND key < ?)",
			)
			.all(
				tagIdentityRevisionKey("session"),
				tagRevisionKey("session"),
				...tagTombstoneOwnerRange("session"),
			);
	try {
		insert(h.local, "session", 1, "before");
		clearSession(h.local, "session");
		expect(rows().length).toBeGreaterThan(0);
		clearSession(h.local, "session", false, true);
		expect(rows()).toEqual([]);
	} finally {
		h.close();
	}
});

it("clear and recreate refreshes fallback call IDs even when tags_version repeats", () => {
	const h = harness();
	try {
		h.local
			.prepare(
				"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES ('session','shared','tool','active',1,0,'pi','pi-msg-0-123-assistant')",
			)
			.run();
		const message = msg("real-owner");
		required(message.content[0]).id = "other";
		const messages = [message] as unknown as Parameters<
			typeof contextTest.guardPiToolAllocations
		>[2];
		expect(
			contextTest.guardPiToolAllocations(
				h.local,
				"session",
				messages,
				() => "real-owner",
			),
		).toEqual([]);
		clearSession(required(h.foreign[0]), "session");
		required(h.foreign[0])
			.prepare(
				"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES ('session','other','tool','active',7,0,'pi','pi-msg-0-123-assistant')",
			)
			.run();
		expect(
			contextTest.guardPiToolAllocations(
				h.local,
				"session",
				messages,
				() => "real-owner",
			),
		).toHaveLength(1);
	} finally {
		h.close();
	}
});
