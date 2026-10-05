import {
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import type { Database } from "@magic-context/core/shared/sqlite";
import { withoutPiLeadingTemporalMarker } from "./temporal-awareness-pi";

interface ReminderTarget {
	getContent?: () => string | null;
	setContent?: (content: string) => void;
}

/** Replay reminder decisions without fetching legacy sources for ordinary defer text. */
export function replayPiReminderStrips(args: {
	db: Database;
	sessionId: string;
	activeTags: readonly TagEntry[];
	targets: ReadonlyMap<number, ReminderTarget>;
	legacyReminderTagNumbers: ReadonlySet<number>;
	cacheBusting: boolean;
}): Set<string> {
	const decisions = getPiContentDecisions(args.db, args.sessionId);
	const candidates = args.activeTags.map((tag) => {
		const target = args.targets.get(tag.tagNumber);
		const content = target?.getContent?.();
		return {
			tag,
			target,
			content,
			stripped: content ? stripSystemInjection(content) : null,
		};
	});
	// A bust must still recognize temporal-only legacy sources and freeze the
	// decision even if today's projection has nothing removable. Defer cannot
	// freeze decisions, so only a removable, undecided projection needs a source.
	const numbers = candidates
		.filter(
			({ tag, stripped }) =>
				!decisions.has(
					encodePiContentDecision("reminder-strip", tag.messageId),
				) &&
				(args.cacheBusting || stripped !== null),
		)
		.map(({ tag }) => tag.tagNumber);
	const sources = new Map<number, string>();
	for (let offset = 0; offset < numbers.length; offset += 500) {
		for (const [number, source] of getSourceContents(
			args.db,
			args.sessionId,
			numbers.slice(offset, offset + 500),
		)) {
			sources.set(number, source);
		}
	}
	for (const { tag, target, content, stripped } of candidates) {
		if (!content) continue;
		const decision = encodePiContentDecision("reminder-strip", tag.messageId);
		let frozen = decisions.has(decision);
		const source = sources.get(tag.tagNumber) ?? "";
		const legacyProjection =
			args.legacyReminderTagNumbers.has(tag.tagNumber) ||
			(source.trimStart().startsWith("<!-- +") &&
				withoutPiLeadingTemporalMarker(`${source}\n`).trim().length === 0);
		if (
			!frozen &&
			args.cacheBusting &&
			legacyProjection &&
			freezePiContentDecision(
				args.db,
				args.sessionId,
				"reminder-strip",
				tag.messageId,
			)
		) {
			decisions.add(decision);
			frozen = true;
		}
		if (stripped === null) continue;
		// Older releases stored the stripped body. Its exact defer projection must
		// survive until a priced pass freezes the normal reminder-strip decision.
		const legacyStripped =
			!frozen && stripTagPrefix(source) === stripTagPrefix(stripped);
		if (frozen || legacyStripped) target?.setContent?.(stripped);
	}
	return decisions;
}
