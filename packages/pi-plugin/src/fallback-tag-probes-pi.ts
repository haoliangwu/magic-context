import {
	hasPiFallbackMessageTags as readMessageTags,
	hasPiFallbackToolOwnerTags as readToolOwnerTags,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readPiTagSnapshotRevision } from "./tag-snapshot-pi";

interface ProbeSnapshot {
	local: number;
	external: number;
	message?: boolean;
	tool?: boolean;
}
const probes = new WeakMap<Database, Map<string, ProbeSnapshot>>();

function probe(
	db: Database,
	sessionId: string,
	kind: "message" | "tool",
): boolean {
	const revision = readPiTagSnapshotRevision(db);
	const read = () =>
		kind === "message"
			? readMessageTags(db, sessionId)
			: readToolOwnerTags(db, sessionId);
	if (!revision) return read();
	let sessions = probes.get(db);
	if (!sessions) {
		sessions = new Map();
		probes.set(db, sessions);
	}
	let snapshot = sessions.get(sessionId);
	if (
		!snapshot ||
		snapshot.local !== revision[0] ||
		snapshot.external !== revision[1]
	) {
		snapshot = { local: revision[0], external: revision[1] };
		if (sessions.size >= 100 && !sessions.has(sessionId)) {
			const oldest = sessions.keys().next().value;
			if (oldest !== undefined) sessions.delete(oldest);
		}
		sessions.set(sessionId, snapshot);
	}
	// Observe revisions again at adoption, not only its earlier preflight. A
	// sibling's new fallback row must invalidate a cached negative result.
	const cached = snapshot[kind];
	if (cached !== undefined) return cached;
	const result = read();
	snapshot[kind] = result;
	return result;
}

export function hasPiFallbackMessageTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "message");
}

export function hasPiFallbackToolOwnerTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "tool");
}
