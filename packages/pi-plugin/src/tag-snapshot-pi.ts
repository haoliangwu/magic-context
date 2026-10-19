import {
	TAG_INSERT_CONFLICT_ROWS,
	tagRevisionCountSql,
	tagRevisionIncarnationSql,
	tagRevisionKey,
} from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	getTagsByNumbers,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Connection-local tag revisions avoid invalidating snapshots for unrelated metadata writes. */
export function createPiTagSnapshotReader(db: Database) {
	const existing = readers.get(db);
	if (existing) return existing;
	// Replace the pi_tag_insert/update/delete TEMP triggers when an extension
	// reload keeps its SQLite connection: older definitions tracked only a
	// revision, not the changed tag numbers needed to update cached rows.
	// An outer write's conflict policy can override OR IGNORE inside a trigger,
	// so journal inserts explicitly exclude keys already present.
	// REPLACE's implicit deletes may skip DELETE triggers. Before insertion,
	// record conflicting rows' old sessions/numbers and the same write counts
	// as the shared revision observer.
	db.exec(`
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_revision (revision INTEGER NOT NULL);
		INSERT INTO pi_tag_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM pi_tag_revision);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_session_revision (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_watch (session_id TEXT PRIMARY KEY);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_changes (session_id TEXT, tag_number INTEGER, PRIMARY KEY (session_id, tag_number));
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_version_own (session_id TEXT PRIMARY KEY, count INTEGER NOT NULL);
		DROP TRIGGER IF EXISTS temp.pi_tag_version_ai;
		DROP TRIGGER IF EXISTS temp.pi_tag_version_ad;
		DROP TRIGGER IF EXISTS temp.pi_tag_version_au;
		DROP TRIGGER IF EXISTS temp.pi_tag_insert;
		DROP TRIGGER IF EXISTS temp.pi_tag_update;
		DROP TRIGGER IF EXISTS temp.pi_tag_delete;
		DROP TRIGGER IF EXISTS temp.pi_tag_insert_conflicts;
		CREATE TEMP TRIGGER pi_tag_insert_conflicts BEFORE INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + (SELECT COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}));
			INSERT INTO pi_tag_session_revision
				SELECT session_id, COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}) GROUP BY session_id
				ON CONFLICT(session_id) DO UPDATE SET revision = revision + excluded.revision;
			INSERT INTO pi_tag_changes
				SELECT session_id, tag_number FROM (${TAG_INSERT_CONFLICT_ROWS}) AS conflicts
				WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = conflicts.session_id)
				AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = conflicts.session_id AND tag_number = conflicts.tag_number)
				GROUP BY session_id, tag_number;
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_insert AFTER INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (NEW.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_update AFTER UPDATE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision SELECT NEW.session_id, 1 WHERE NEW.session_id IS NOT OLD.session_id ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_delete AFTER DELETE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
		END;
		CREATE TEMP TRIGGER pi_tag_version_ai AFTER INSERT ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (NEW.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
		CREATE TEMP TRIGGER pi_tag_version_ad AFTER DELETE ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
		CREATE TEMP TRIGGER pi_tag_version_au
		AFTER UPDATE OF session_id, message_id, tag_number, type, tool_owner_message_id, status ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
			INSERT INTO pi_tag_version_own SELECT NEW.session_id, 1 WHERE NEW.session_id != OLD.session_id
				ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
	`);
	// Writers from builds older than the tag_revision: triggers (and connections
	// that never ran initializeDatabase) do not advance the shared revision, so
	// the snapshot cannot see their commits. Every writer does advance the
	// durable session_meta.tags_version through schema triggers. The TEMP
	// pi_tag_version_* triggers above count this connection's firings of those
	// same events, so a durable advance this connection did not make is a write
	// the revision missed. Other bumps of tags_version (session clears, the
	// REPLACE conflict trigger) only cause a conservative extra rescan.
	const versionStamp = db.prepare(`SELECT
		COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS durable,
		COALESCE((SELECT count FROM pi_tag_version_own WHERE session_id = ?), 0) AS own`);
	const revision = db.prepare(`WITH stamp AS (SELECT
		COALESCE((SELECT revision FROM pi_tag_session_revision WHERE session_id = ?), 0) AS own,
		COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS total)
		SELECT CAST(own AS TEXT) AS local,
		(${tagRevisionIncarnationSql("total")}) || ':' || CAST(${tagRevisionCountSql("total")} - own AS TEXT) AS foreign_revision FROM stamp`);
	revisionReaders.set(db, (sessionId) => {
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		const row = revision.get(sessionId, tagRevisionKey(sessionId)) as {
			local: string;
			foreign_revision: string;
		};
		return [row.local, row.foreign_revision] as const;
	});
	const changed = db.prepare(
		"SELECT tag_number FROM pi_tag_changes WHERE session_id = ? ORDER BY tag_number",
	);
	const clearChanged = db.prepare(
		"DELETE FROM pi_tag_changes WHERE session_id = ?",
	);
	const watch = db.prepare("INSERT OR IGNORE INTO pi_tag_watch VALUES (?)");
	const unwatch = db.prepare("DELETE FROM pi_tag_watch WHERE session_id = ?");
	const cache = new Map<string, SnapshotEntry>();
	const fallbackRows = db.prepare(
		`SELECT ${FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = ? AND ${FALLBACK_ROW_PREDICATE}`,
	);
	const fallbackRowsByNumbers = db.prepare(
		`SELECT ${FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = ?
		 AND tag_number IN (SELECT value FROM json_each(?)) AND ${FALLBACK_ROW_PREDICATE}`,
	);
	/** Bring the cached entry up to date, or return null inside a transaction. */
	const sync = (sessionId: string): SnapshotEntry | null => {
		// Do not publish or consume journal entries inside a transaction: its
		// rows may roll back while the in-memory snapshot cannot roll back.
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		// Subtract this connection's writes from the shared session counter. Both
		// counters roll back with the rows; unrelated foreign commits do not matter.
		const [local, external] = revisionReaders.get(db)?.(sessionId) ?? [
			"0",
			"0:0",
		];
		const stamp = versionStamp.get(sessionId, sessionId) as {
			durable: number;
			own: number;
		};
		let snapshot = cache.get(sessionId);
		if (!snapshot || snapshot.foreignRevision !== external) {
			// Another connection changed this session's tags. There is no record
			// of which rows, so reread them all, but reuse the cached object for
			// every unchanged row. Consumers that diff rows by object identity
			// (tagAttribution in tail-hygiene-walk-pi.ts) then see only the rows
			// that actually changed.
			const tags = snapshot
				? reuseUnchangedRows(snapshot.tags, getTagsBySession(db, sessionId))
				: getTagsBySession(db, sessionId);
			snapshot = {
				revision: local,
				foreignRevision: external,
				tags,
				active: tags.filter(isActive),
				durableVersion: stamp.durable,
				ownVersion: stamp.own,
			};
			if (cache.size >= 100 && !cache.has(sessionId)) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) {
					cache.delete(oldest);
					unwatch.run(oldest);
					clearChanged.run(oldest);
				}
			}
			cache.set(sessionId, snapshot);
			for (const tag of snapshot.tags) Object.freeze(tag);
			watch.run(sessionId);
		} else if (snapshot.revision !== local) {
			const numbers = (changed.all(sessionId) as { tag_number: number }[]).map(
				(row) => row.tag_number,
			);
			if (numbers.length > 0) {
				const dirty = new Set(numbers);
				const replacements = getTagsByNumbers(db, sessionId, numbers);
				for (const tag of replacements) Object.freeze(tag);
				snapshot.tags = mergeChangedRows(snapshot.tags, dirty, replacements);
				// The active projection follows the same rows: only changed numbers
				// can enter or leave it, so it is merged rather than refiltered.
				snapshot.active = mergeChangedRows(
					snapshot.active,
					dirty,
					replacements.filter(isActive),
				);
				if (!numbers.every(Number.isSafeInteger)) {
					// A NULL tag number cannot be re-read by number; rescan on next use.
					snapshot.fallback = undefined;
				} else if (snapshot.fallback) {
					// A changed number may have gained, lost or rewritten a fallback
					// row. Re-read only those numbers with the same predicate.
					snapshot.fallback = [
						...snapshot.fallback.filter((row) => !dirty.has(row.tag_number)),
						...(fallbackRowsByNumbers.all(
							sessionId,
							JSON.stringify(numbers),
						) as PiFallbackTagRow[]),
					];
				}
			}
			snapshot.revision = local;
		}
		if (
			stamp.durable - snapshot.durableVersion !==
			stamp.own - snapshot.ownVersion
		) {
			// session_meta.tags_version is advanced by schema triggers on every
			// tag write from any connection, while ownVersion counts only this
			// connection's writes. A difference beyond our own writes means
			// another connection changed tags without advancing the shared
			// `tag_revision:` key, typically an older Magic Context build, so
			// this connection's change journal never saw the write. Fallback rows
			// are tags still keyed by a temporary `pi-msg-*` id, before Pi has
			// assigned the message its real entry id. They decide whether this
			// pass looks for tags to move onto real ids, so rescan them on next
			// use. The cached tag rows are left as they are for such writers,
			// which is unchanged behaviour.
			snapshot.fallback = undefined;
		}
		snapshot.durableVersion = stamp.durable;
		snapshot.ownVersion = stamp.own;
		clearChanged.run(sessionId);
		return snapshot;
	};
	const read = (
		sessionId: string,
		borrowed = false,
	): ReturnType<typeof getTagsBySession> => {
		const snapshot = sync(sessionId);
		if (!snapshot) return getTagsBySession(db, sessionId);
		// Heuristics can edit their working entries; never expose the cached objects.
		return borrowed ? snapshot.tags : snapshot.tags.map((tag) => ({ ...tag }));
	};
	entryReaders.set(db, sync);
	fallbackReaders.set(db, (sessionId) => {
		const snapshot = sync(sessionId);
		if (!snapshot) return null;
		snapshot.fallback ??= fallbackRows.all(sessionId) as PiFallbackTagRow[];
		return snapshot.fallback;
	});
	readers.set(db, read);
	return read;
}

type SnapshotTag = ReturnType<typeof getTagsBySession>[number];

/**
 * A tag row that names an unsettled Pi id: a message tag stored under a
 * `pi-msg-*` fallback message id, or a tool tag whose owner is one. Columns are
 * raw SQL values, so callers apply exactly the filters their SQL used to.
 */
export interface PiFallbackTagRow {
	id: number;
	tag_number: number;
	type: unknown;
	message_id: unknown;
	tool_owner_message_id: unknown;
	entry_fingerprint: unknown;
}

// Selects every fallback row: a message tag under a `pi-msg-*` id, or a tool
// tag whose owner message has one. Every check that asks whether such rows
// exist reads these cached rows instead of querying the table. Matching stays
// in SQL's own LIKE (ASCII case-insensitive), so the cached set is exactly the
// set a direct table query would return.
const FALLBACK_ROW_COLUMNS =
	"id, tag_number, type, message_id, tool_owner_message_id, entry_fingerprint";
const FALLBACK_ROW_PREDICATE = `((type = 'message' AND message_id LIKE 'pi-msg-%')
	OR (type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'))`;

interface SnapshotEntry {
	revision: string;
	foreignRevision: string;
	tags: SnapshotTag[];
	/** `tags` rows whose status is "active", in the same order. */
	active: SnapshotTag[];
	/**
	 * At the last sync: session_meta.tags_version (durableVersion) and how many
	 * of its advances this connection's own tag writes caused (ownVersion).
	 */
	durableVersion: number;
	ownVersion: number;
	/**
	 * Fallback rows, loaded on first use after each full reload (a reread of
	 * every row of the session) and then kept current from the same journal as
	 * `tags`: the TEMP table pi_tag_changes, filled by this connection's tag
	 * triggers with the numbers changed since the last read.
	 */
	fallback?: PiFallbackTagRow[];
}

const isActive = (tag: SnapshotTag) => tag.status === "active";

function sameRow(
	left: SnapshotTag,
	right: SnapshotTag,
	keys: readonly (keyof SnapshotTag)[],
): boolean {
	for (const key of keys) if (!Object.is(left[key], right[key])) return false;
	return true;
}

/**
 * Return `fresh` with each row that equals its cached counterpart (same id,
 * same fields) replaced by the cached frozen object. Both lists are in
 * canonical tag_number/id order, so one merge walk pairs them.
 */
function reuseUnchangedRows(
	cached: readonly SnapshotTag[],
	fresh: SnapshotTag[],
): SnapshotTag[] {
	// Every row of both lists was built by the same toTagEntry, so they share
	// one key set; read it once instead of per row.
	const first = fresh[0];
	if (!first) return fresh;
	const keys = Object.keys(first) as (keyof SnapshotTag)[];
	let index = 0;
	for (let position = 0; position < fresh.length; position += 1) {
		const row = fresh[position];
		if (!row) continue;
		while (index < cached.length) {
			const old = cached[index];
			if (
				!old ||
				old.tagNumber > row.tagNumber ||
				(old.tagNumber === row.tagNumber && (old.id ?? 0) >= (row.id ?? 0))
			)
				break;
			index += 1;
		}
		const old = cached[index];
		if (old && old.id === row.id && sameRow(old, row, keys))
			fresh[position] = old;
	}
	return fresh;
}

/**
 * Replace the rows of `dirty` tag numbers in canonical tag_number/id order.
 * Both inputs use that order, including duplicate tag numbers in legacy stores.
 */
function mergeChangedRows(
	rows: readonly SnapshotTag[],
	dirty: ReadonlySet<number>,
	replacements: readonly SnapshotTag[],
): SnapshotTag[] {
	const highest = rows.at(-1)?.tagNumber ?? -1;
	let appendOnly = true;
	for (const number of dirty) {
		if (number <= highest) {
			appendOnly = false;
			break;
		}
	}
	// Ordinary appends already have canonical order. Do not filter or merge the
	// historical prefix just to add a few new rows.
	if (appendOnly) return [...rows, ...replacements];
	const unchanged = rows.filter((tag) => !dirty.has(tag.tagNumber));
	const merged: SnapshotTag[] = [];
	let index = 0;
	for (const tag of unchanged) {
		while (index < replacements.length) {
			const next = replacements[index];
			if (!next) break;
			if (
				next.tagNumber > tag.tagNumber ||
				(next.tagNumber === tag.tagNumber && (next.id ?? 0) > (tag.id ?? 0))
			)
				break;
			merged.push(next);
			index += 1;
		}
		merged.push(tag);
	}
	merged.push(...replacements.slice(index));
	return merged;
}

const entryReaders = new WeakMap<
	Database,
	(sessionId: string) => SnapshotEntry | null
>();

const fallbackReaders = new WeakMap<
	Database,
	(sessionId: string) => readonly PiFallbackTagRow[] | null
>();

const readers = new WeakMap<
	Database,
	(sessionId: string, borrowed?: boolean) => ReturnType<typeof getTagsBySession>
>();

const revisionReaders = new WeakMap<
	Database,
	(sessionId: string) => readonly [string, string] | null
>();

/** Revision for tag-only observations; transactions must use uncached reads. */
export function readPiTagSnapshotRevision(
	db: Database,
	sessionId: string,
): readonly [string, string] | null {
	if (!readers.has(db)) createPiTagSnapshotReader(db);
	return revisionReaders.get(db)?.(sessionId) ?? null;
}

export function getPiTagSnapshot(db: Database, sessionId: string) {
	let reader = readers.get(db);
	if (!reader) {
		reader = createPiTagSnapshotReader(db);
		readers.set(db, reader);
	}
	return reader(sessionId);
}

/** Internal read-only projection. Changed rows get new objects; unchanged rows retain identity. */
export function getPiTagSnapshotView(db: Database, sessionId: string) {
	return createPiTagSnapshotReader(db)(sessionId, true);
}

/**
 * Internal read-only projection of the rows whose status is "active", in tag
 * order: the same rows as filtering `getPiTagSnapshotView`, maintained from
 * changed rows instead of refiltering every tag of the session. Rows are the
 * frozen cached objects. Pass `passTags`, the full list this caller already
 * read, to keep both lists one tag state: if the snapshot has moved since that
 * read (another connection committed in between), or inside a transaction,
 * the result is a filter of `passTags` itself.
 */
export function getPiActiveTagSnapshotView(
	db: Database,
	sessionId: string,
	passTags?: readonly SnapshotTag[],
): SnapshotTag[] {
	createPiTagSnapshotReader(db);
	const snapshot = entryReaders.get(db)?.(sessionId);
	// Copy the array (not the frozen rows) so a caller that sorts or splices
	// its list cannot reorder the cached projection. Every change to the rows
	// publishes a new `tags` array, so the same array means the same state.
	if (snapshot && (!passTags || snapshot.tags === passTags))
		return snapshot.active.slice();
	return (passTags ?? getTagsBySession(db, sessionId)).filter(isActive);
}

/**
 * Current fallback rows of a session (see PiFallbackTagRow), or null inside a
 * transaction, where callers must query the table themselves. Rows are kept
 * up to date from the changed-number journal, so a pass that only appends
 * tags never rescans the session for `pi-msg-*` ids.
 */
export function readPiFallbackTagRows(
	db: Database,
	sessionId: string,
): readonly PiFallbackTagRow[] | null {
	createPiTagSnapshotReader(db);
	return fallbackReaders.get(db)?.(sessionId) ?? null;
}
