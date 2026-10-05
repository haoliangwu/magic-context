import {
	getTagsByNumbers,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Connection-local tag revisions avoid invalidating snapshots for unrelated metadata writes. */
export function createPiTagSnapshotReader(db: Database) {
	const existing = readers.get(db);
	if (existing) return existing;
	// A reloaded extension can inherit the connection's older TEMP triggers,
	// which observed revisions but not changed numbers. Replace only those
	// connection-local definitions. Journal inserts avoid duplicate keys rather
	// than relying on OR IGNORE, which an outer write's conflict policy can override.
	db.exec(`
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_revision (revision INTEGER NOT NULL);
		INSERT INTO pi_tag_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM pi_tag_revision);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_watch (session_id TEXT PRIMARY KEY);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_changes (session_id TEXT, tag_number INTEGER, PRIMARY KEY (session_id, tag_number));
		DROP TRIGGER IF EXISTS temp.pi_tag_insert;
		DROP TRIGGER IF EXISTS temp.pi_tag_update;
		DROP TRIGGER IF EXISTS temp.pi_tag_delete;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_insert AFTER INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_update AFTER UPDATE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_delete AFTER DELETE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
		END;
	`);
	const revision = db.prepare("SELECT revision FROM pi_tag_revision");
	const dataVersion = db.prepare("PRAGMA main.data_version");
	revisionReaders.set(db, () => {
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		return [
			(revision.get() as { revision: number }).revision,
			(dataVersion.get() as { data_version: number }).data_version,
		] as const;
	});
	const changed = db.prepare(
		"SELECT tag_number FROM pi_tag_changes WHERE session_id = ? ORDER BY tag_number",
	);
	const clearChanged = db.prepare(
		"DELETE FROM pi_tag_changes WHERE session_id = ?",
	);
	const watch = db.prepare("INSERT OR IGNORE INTO pi_tag_watch VALUES (?)");
	const unwatch = db.prepare("DELETE FROM pi_tag_watch WHERE session_id = ?");
	const cache = new Map<
		string,
		{
			revision: number;
			dataVersion: number;
			tags: ReturnType<typeof getTagsBySession>;
		}
	>();
	const read = (sessionId: string): ReturnType<typeof getTagsBySession> => {
		// Do not publish or consume journal entries inside a transaction: its
		// rows may roll back while the in-memory snapshot cannot roll back.
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction)
			return getTagsBySession(db, sessionId);
		const local = (revision.get() as { revision: number }).revision;
		// data_version observes other connections; the TEMP triggers observe this one,
		// including direct SQL and rolled-back transactions, without a durable schema change.
		const external = (dataVersion.get() as { data_version: number })
			.data_version;
		let snapshot = cache.get(sessionId);
		if (!snapshot || snapshot.dataVersion !== external) {
			snapshot = {
				revision: local,
				dataVersion: external,
				tags: getTagsBySession(db, sessionId),
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
			watch.run(sessionId);
		} else if (snapshot.revision !== local) {
			const numbers = (changed.all(sessionId) as { tag_number: number }[]).map(
				(row) => row.tag_number,
			);
			if (numbers.length > 0) {
				const dirty = new Set(numbers);
				const replacements = getTagsByNumbers(db, sessionId, numbers);
				const unchanged = snapshot.tags.filter(
					(tag) => !dirty.has(tag.tagNumber),
				);
				// Both inputs use the authoritative tag_number/id order, including
				// duplicate tag numbers in legacy stores. Merge without re-sorting history.
				const merged: typeof unchanged = [];
				let index = 0;
				for (const tag of unchanged) {
					while (index < replacements.length) {
						const next = replacements[index];
						if (!next) break;
						if (
							next.tagNumber > tag.tagNumber ||
							(next.tagNumber === tag.tagNumber &&
								(next.id ?? 0) > (tag.id ?? 0))
						)
							break;
						merged.push(next);
						index += 1;
					}
					merged.push(tag);
				}
				merged.push(...replacements.slice(index));
				snapshot.tags = merged;
			}
			snapshot.revision = local;
		}
		clearChanged.run(sessionId);
		// Heuristics can edit their working entries; never expose the cached objects.
		return snapshot.tags.map((tag) => ({ ...tag }));
	};
	readers.set(db, read);
	return read;
}

const readers = new WeakMap<
	Database,
	(sessionId: string) => ReturnType<typeof getTagsBySession>
>();

const revisionReaders = new WeakMap<
	Database,
	() => readonly [number, number] | null
>();

/** Revision for tag-only observations; transactions must use uncached reads. */
export function readPiTagSnapshotRevision(
	db: Database,
): readonly [number, number] | null {
	if (!readers.has(db)) createPiTagSnapshotReader(db);
	return revisionReaders.get(db)?.() ?? null;
}

export function getPiTagSnapshot(db: Database, sessionId: string) {
	let reader = readers.get(db);
	if (!reader) {
		reader = createPiTagSnapshotReader(db);
		readers.set(db, reader);
	}
	return reader(sessionId);
}
