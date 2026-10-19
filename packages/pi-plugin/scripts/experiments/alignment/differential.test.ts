/**
 * Served-byte differential for the Pi entry-id alignment change.
 *
 * Drives the real `context` handler through a scripted Pi 0.87.1 session and
 * prints one sha256 per pass over the served message array. Run the same file
 * in two checkouts (before and after a change) and compare the printed lines;
 * any differing hash is a served-byte difference between the two builds.
 *
 *   MC_ALIGN_DIFF=1 bun test scripts/experiments/alignment/differential.test.ts
 *
 * The session is built by hand (deterministic entry ids and timestamps) and
 * projected with Pi 0.87.1's own `buildSessionContext`, which applies
 * compaction, branch summaries, custom messages and `context_edit` omissions.
 * Two event shapes are replayed: "pi087" withholds system messages the way Pi
 * 0.87 runner.js emitContext does, and "systems" keeps them, the shape of a
 * host that still shows system messages to `context` handlers.
 *
 * Upgrade mode: MC_ALIGN_DB names a database file, and MC_ALIGN_FROM /
 * MC_ALIGN_TO limit which passes are served (the session is still built in
 * full, so later passes see the same entries). Serving passes [0, k) from one
 * checkout and [k, end) from another against the same file reproduces a host
 * restart onto a new build in the middle of a session. MC_ALIGN_SCENARIO picks
 * the session script (see SCENARIO below).
 *
 * Each line also counts the resolver diagnostics logged during the pass, so a
 * reader can see which entry-id lane each build took: `collect` is the
 * fingerprint fallback's coverage line (logged when some message stays
 * unresolved) and `mismatch` is the positional lane's rejection line.
 */
import { expect, it, setSystemTime, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import { buildSessionContext } from "pi-coding-agent-087";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../../../src/context-handler";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "../../../src/served-array-ledger";
import { createFakePi, createTestDb } from "../../../src/test-utils.test";

type Entry = Record<string, unknown> & {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
};

const START = 1_800_000_000_000;

class ScriptedSession {
	readonly byId = new Map<string, Entry>();
	leafId: string | null = null;
	clock = START;
	private next = 0;

	tick(ms = 1_000): number {
		this.clock += ms;
		return this.clock;
	}

	private add(row: Omit<Entry, "id" | "parentId" | "timestamp">): string {
		const id = `e${String(this.next++).padStart(3, "0")}`;
		const entry = {
			...row,
			id,
			parentId: this.leafId,
			timestamp: new Date(this.clock).toISOString(),
		} as Entry;
		this.byId.set(id, entry);
		this.leafId = id;
		return id;
	}

	message(message: Record<string, unknown>, advance = true): string {
		if (advance) this.tick();
		return this.add({
			type: "message",
			message: { timestamp: this.clock, ...message },
		});
	}

	custom(customType: string, text: string): string {
		this.tick();
		return this.add({
			type: "custom_message",
			customType,
			content: [{ type: "text", text }],
			display: true,
		});
	}

	branchWithSummary(fromLeaf: string, summary: string): string {
		this.tick();
		const fromId = this.leafId ?? "root";
		this.leafId = fromLeaf;
		return this.add({ type: "branch_summary", fromId, summary });
	}

	compaction(summary: string, firstKeptEntryId: string): string {
		this.tick();
		const system = [...this.branch()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "message" &&
					(entry.message as { role?: string }).role === "system",
			);
		return this.add({
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore: 50_000,
			...(system
				? {
						systemMessage: {
							...(system.message as object),
							timestamp: this.clock,
						},
					}
				: {}),
		});
	}

	omit(targetId: string): string {
		this.tick();
		return this.add({ type: "context_edit", targetId, replacement: null });
	}

	branch(): Entry[] {
		const path: Entry[] = [];
		let cursor = this.leafId;
		while (cursor) {
			const entry = this.byId.get(cursor);
			if (!entry) break;
			path.push(entry);
			cursor = entry.parentId;
		}
		return path.reverse();
	}
}

function assistant(text: string, responseId: string, extra = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		responseId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...extra,
	};
}

const DB_PATH = process.env.MC_ALIGN_DB;
const FROM = Number(process.env.MC_ALIGN_FROM ?? 0);
const TO = Number(process.env.MC_ALIGN_TO ?? 99);
// "default" abandons the duplicate pair on a side branch; "kept-duplicates"
// keeps it across a compaction, where the visible array shifts left;
// "issue-650" seeds a second tag row for an already served tool call, the
// duplicate-identity state behind GitHub issue 650 (see issue650 below).
const SCENARIO = process.env.MC_ALIGN_SCENARIO ?? "default";

/**
 * Second half of the "issue-650" scenario (passes 2-7). A tool call is served
 * once under its real assistant entry; then a second tag row for the same
 * call is seeded under a temporary `pi-msg-*` owner, as an older build could
 * leave it, and the process "restarts" (in-memory served array cleared, the
 * durable served-number ledger kept, both numbers recorded as served). Every
 * later pass must serve: one declared identity repair, then stable numbers
 * through a context_edit omission, a compaction and appends. An earlier
 * extension also edits the assistant's prose in every event copy: in issue
 * 650 that edit is how the call lost its link to its real assistant entry,
 * which led to the second tag.
 */
async function issue650(
	s: ScriptedSession,
	serve: (label: string) => Promise<void>,
	seedDuplicate: () => void,
	setEventEdit: (edit: ((messages: unknown[]) => void) | undefined) => void,
): Promise<void> {
	s.message({ role: "user", content: "Run the build." });
	s.message(
		assistant("Running it.", "rt", {
			content: [
				{ type: "text", text: "Running it." },
				{ type: "toolCall", id: "call-650", name: "bash", arguments: {} },
			],
			stopReason: "toolUse",
		}),
	);
	s.message({
		role: "toolResult",
		toolCallId: "call-650",
		toolName: "bash",
		content: [{ type: "text", text: "build ok" }],
		isError: false,
	});
	s.message(assistant("Build is green.", "r2"));
	await serve("tool-call");
	seedDuplicate();
	s.message({ role: "user", content: "Again." });
	s.message(assistant("Still green.", "r3"));
	await serve("after-restart-with-duplicate");
	const failed = s.message(
		assistant("", "r4", { stopReason: "error", errorMessage: "overloaded" }),
	);
	s.omit(failed);
	const retry = s.message({ role: "user", content: "Retry please." });
	s.message(assistant("Retried.", "r5"));
	await serve("context-edit-omission");
	s.compaction("Earlier work summarized.", retry);
	s.message({ role: "user", content: "After compaction." });
	s.message(assistant("Noted.", "r6"));
	await serve("compaction");
	s.message({ role: "user", content: "One more." });
	s.message(assistant("Done.", "r7"));
	await serve("append-after-compaction");
	s.message({ role: "user", content: "Last." });
	s.message(assistant("Bye.", "r8"));
	await serve("append");
	await issue650Field(s, serve, setEventEdit);
}

/**
 * Passes 8-13 of the "issue-650" scenario: the Oh My Pi and pi-rewind shapes
 * from the second 650 review's field evidence. Every pass must serve (a
 * refusal would throw out of serve), and the counters on each line show at
 * most the one declared repair of the seeded duplicate.
 *
 * - An Oh My Pi request-built note: a user message in the context event that
 *   is not a branch entry, so no lane maps it (stable timestamp and text).
 * - An event-only custom message ahead of it, which moves its index.
 * - A lane switch: a message whose event copy has more content than its entry
 *   (an attachment note) is mapped by header; then a persisted custom message
 *   is emitted out of projection order, so the pass falls to the fingerprint
 *   lane.
 * - A pi-rewind `/rewind` (`navigateTree` with a summary) back to the turn
 *   just before the note.
 */
async function issue650Field(
	s: ScriptedSession,
	serve: (label: string) => Promise<void>,
	setEventEdit: (edit: ((messages: unknown[]) => void) | undefined) => void,
): Promise<void> {
	const note = {
		role: "user",
		content: [{ type: "text", text: "Context notes: build is green" }],
		timestamp: START + 5,
	};
	const beforeLastUser = (messages: unknown[], extra: unknown[]) => {
		const last = messages.findLastIndex(
			(message) => (message as { role?: string }).role === "user",
		);
		messages.splice(last < 0 ? messages.length : last, 0, ...extra);
	};
	s.message({ role: "user", content: "Check the deploy." });
	setEventEdit((messages) => beforeLastUser(messages, [structuredClone(note)]));
	await serve("omp-request-built");
	s.message(assistant("Deploy looks fine.", "r9"));
	s.message({ role: "user", content: "And the logs?" });
	setEventEdit((messages) => {
		messages.unshift({
			role: "custom",
			customType: "omp-context",
			content: [{ type: "text", text: "request-built" }],
			display: false,
			timestamp: START + 4,
		});
		beforeLastUser(messages, [structuredClone(note)]);
	});
	await serve("custom-shifts-index");
	s.custom("note", "A persisted note.");
	const attached = s.message({ role: "user", content: "look at this" });
	const withAttachment = (messages: unknown[]) => {
		const entry = s.byId.get(attached)?.message as { timestamp: number };
		for (const message of messages as {
			role?: string;
			timestamp?: number;
			content?: unknown;
		}[])
			if (message.role === "user" && message.timestamp === entry.timestamp)
				message.content = "look at this [image: 1 attachment]";
	};
	setEventEdit((messages) => {
		withAttachment(messages);
		beforeLastUser(messages, [structuredClone(note)]);
	});
	await serve("content-rewrite-header-lane");
	const rewindTarget = s.message(assistant("A screenshot.", "r10"));
	s.message({ role: "user", content: "Thanks." });
	setEventEdit((messages) => {
		withAttachment(messages);
		const custom = messages.findIndex(
			(message) => (message as { role?: string }).role === "custom",
		);
		if (custom >= 0) messages.push(...messages.splice(custom, 1));
		beforeLastUser(messages, [structuredClone(note)]);
	});
	await serve("lane-switch-fingerprint");
	s.message(assistant("You're welcome.", "r11"));
	s.branchWithSummary(rewindTarget, "Rewound past a thank-you.");
	s.message({ role: "user", content: "Rewound; continue." });
	await serve("pi-rewind");
	s.message(assistant("Continuing after rewind.", "r12"));
	s.message({ role: "user", content: "Final." });
	await serve("append-after-rewind");
	setEventEdit(undefined);
}

/**
 * Second half of the "kept-duplicates" scenario (passes 2-7). Pi omits a
 * failed attempt, then two identical user messages arrive in one millisecond
 * and survive a compaction whose kept range starts at the first of them.
 */
async function keptDuplicates(
	s: ScriptedSession,
	a1: string,
	serve: (label: string) => Promise<void>,
): Promise<void> {
	s.message({ role: "user", content: "Try a refactor." });
	s.message(assistant("Refactored.", "rx"));
	s.branchWithSummary(a1, "Tried a refactor and abandoned it.");
	s.message({ role: "user", content: "Different approach." });
	await serve("branch-summary");
	const failed = s.message(
		assistant("", "r3", { stopReason: "error", errorMessage: "overloaded" }),
	);
	s.omit(failed);
	s.message(assistant("Retried.", "r4"));
	await serve("context-edit-omission");
	const firstDuplicate = s.message({ role: "user", content: "continue" });
	s.message({ role: "user", content: "continue" }, false);
	s.message(assistant("Continuing.", "r5"));
	await serve("duplicate-users");
	s.compaction("Earlier work summarized.", firstDuplicate);
	s.message({ role: "user", content: "After compaction." });
	s.message(assistant("Noted.", "r6"));
	await serve("compaction-keeps-duplicates");
	s.message({ role: "user", content: "One more." });
	s.message(assistant("Done.", "r7"));
	await serve("append-after-compaction");
	s.message({ role: "user", content: "Last." });
	s.message(assistant("Bye.", "r8"));
	await serve("append");
}

async function replay(shape: "pi087" | "systems"): Promise<string[]> {
	const sessionId = `align-diff-${shape}`;
	const db = createTestDb(
		DB_PATH ? `${DB_PATH}.${SCENARIO}.${shape}` : ":memory:",
	);
	const logLines: string[] = [];
	const logSpy = spyOn(logger, "log").mockImplementation((...args) => {
		logLines.push(String(args[0]));
	});
	const sessionLogSpy = spyOn(logger, "sessionLog").mockImplementation(
		(...args) => {
			logLines.push(String(args[1]));
		},
	);
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10_000 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] } | undefined>;
	const s = new ScriptedSession();
	const lines: string[] = [];
	let pass = 0;
	let eventEdit: ((messages: unknown[]) => void) | undefined;
	const serve = async (label: string) => {
		setSystemTime(new Date(s.tick(10)));
		if (pass < FROM || pass >= TO) {
			pass += 1;
			return;
		}
		logLines.length = 0;
		const entries = s.branch();
		const projected = buildSessionContext(
			entries as never,
			s.leafId,
			s.byId as never,
		).messages as unknown[];
		const messages = structuredClone(projected).filter(
			(message) =>
				shape === "systems" ||
				(message as { role?: unknown }).role !== "system",
		);
		eventEdit?.(messages);
		if (SCENARIO === "issue-650") {
			// An earlier extension rewrites the tool-calling assistant's prose in
			// the event copy only; the persisted entry keeps its original text.
			for (const message of messages as {
				role?: string;
				content?: { type: string; text?: string; id?: string }[];
			}[]) {
				const parts = Array.isArray(message.content) ? message.content : [];
				if (
					message.role === "assistant" &&
					parts.some((part) => part.id === "call-650")
				)
					for (const part of parts)
						if (part.type === "text") part.text = `${part.text} (annotated)`;
			}
		}
		const ctx = {
			cwd: "/nonexistent/align-diff",
			hasUI: false,
			signal: new AbortController().signal,
			ui: { notify: () => undefined },
			model: {
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				contextWindow: 200_000,
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => s.leafId,
				getEntry: (id: string) => s.byId.get(id),
				getBranch: () => s.branch(),
			},
			getContextUsage: () => ({
				tokens: 10_000,
				percent: 5,
				contextWindow: 200_000,
			}),
		};
		const served = await handler({ messages }, ctx);
		const out = served?.messages ?? messages;
		const json = JSON.stringify(out);
		const tags = [...json.matchAll(/§(\d+)§/g)].map((match) => match[1]);
		const countLines = (text: string) =>
			logLines.filter((line) => line.includes(text)).length;
		const collect = logLines.filter((line) =>
			line.includes("collectMessageEntryIdsByRef: resolved="),
		).length;
		const mismatch = logLines.filter((line) =>
			line.startsWith("pi entry alignment:"),
		).length;
		// Identity counters, shown only for the scenario that exercises them so
		// the other scenarios' lines stay comparable with older builds.
		const identity =
			SCENARIO === "issue-650"
				? ` repairs=${countLines("tag identity repair without last-served evidence")} recurring=${countLines("tag identity recurred after its one repair")} unresolved=${countLines("tag identity unresolved:")} note=${/§(\d+)§ Context notes/.exec(json)?.[1] ?? "-"} attached=${/§(\d+)§ look at this/.exec(json)?.[1] ?? "-"}`
				: "";
		lines.push(
			`${SCENARIO} ${shape} pass=${pass++} ${label} in=${messages.length} out=${out.length} sha256=${createHash("sha256").update(json).digest("hex")} tags=${tags.join(",")} collect=${collect} mismatch=${mismatch}${identity}`,
		);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: s.clock,
			cacheTtl: "59m",
			lastContextPercentage: 5,
			lastInputTokens: 10_000,
		});
	};
	try {
		setSystemTime(new Date(START));
		s.message({ role: "system", content: "You are a coding agent." }, false);
		s.message({ role: "user", content: "Read the config loader." });
		s.message(assistant("It parses JSONC.", "r0"));
		await serve("plain");
		s.custom("note", "A note another extension persisted.");
		s.message({ role: "user", content: "Now the tests." });
		const a1 = s.message(assistant("They pass.", "r1"));
		await serve("custom-message");
		if (SCENARIO === "kept-duplicates") {
			await keptDuplicates(s, a1, serve);
			return lines;
		}
		if (SCENARIO === "issue-650") {
			await issue650(
				s,
				serve,
				() => {
					const real = db
						.prepare(
							"SELECT tag_number AS n, tool_owner_message_id AS owner FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call-650'",
						)
						.get(sessionId) as { n: number; owner: string };
					const duplicate = 500;
					insertTag(
						db,
						sessionId,
						"call-650",
						"tool",
						100,
						duplicate,
						0,
						"bash",
						0,
						`pi-msg-9-${(s.byId.get(real.owner)?.message as { timestamp: number }).timestamp}-assistant`,
					);
					// Both numbers were served by some earlier build; then the process
					// restarted, so no in-memory served array survives.
					capturePiServedArray(sessionId, [], {
						servedTagNumbers: [real.n, duplicate],
					});
					clearPiServedArraySession(sessionId);
					resetLkgSlotsForTest();
					lines.push(
						`${SCENARIO} ${shape} seeded duplicate real=${real.n} fallback=${duplicate}`,
					);
				},
				(edit) => {
					eventEdit = edit;
				},
			);
			return lines;
		}
		// Two identical user messages stamped in the same millisecond: their
		// content fingerprints collide, so only positions can tell them apart.
		s.message({ role: "user", content: "continue" });
		s.message({ role: "user", content: "continue" }, false);
		s.message(assistant("Continuing.", "r2"));
		await serve("duplicate-users");
		s.branchWithSummary(a1, "Tried a refactor and abandoned it.");
		s.message({ role: "user", content: "Different approach." });
		const failed = s.message(
			assistant("", "r3", { stopReason: "error", errorMessage: "overloaded" }),
		);
		await serve("branch-summary");
		// Pi 0.87.1 omits a failed attempt from the model context before retrying.
		s.omit(failed);
		const u4 = s.message({ role: "user", content: "Retry please." });
		s.message(assistant("Retried.", "r4"));
		await serve("context-edit-omission");
		s.compaction("Earlier work summarized.", u4);
		s.message({ role: "user", content: "After compaction." });
		s.message(assistant("Noted.", "r5"));
		await serve("compaction");
		s.message({ role: "user", content: "One more." });
		s.message(assistant("Done.", "r6"));
		await serve("append-after-compaction");
		s.message({ role: "user", content: "Last." });
		s.message(assistant("Bye.", "r7"));
		await serve("append");
		return lines;
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
		setSystemTime();
		logSpy.mockRestore();
		sessionLogSpy.mockRestore();
	}
}

it.skipIf(!process.env.MC_ALIGN_DIFF)(
	"prints served-array hashes for the scripted Pi session",
	async () => {
		const lines = [...(await replay("pi087")), ...(await replay("systems"))];
		for (const line of lines) console.log(`ALIGN_DIFF ${line}`);
		const seeded = SCENARIO === "issue-650" ? 2 : 0;
		const passes = SCENARIO === "issue-650" ? 14 : 8;
		expect(lines.length).toBe(
			2 * (Math.min(TO, passes) - Math.min(FROM, passes)) + seeded,
		);
		if (SCENARIO === "issue-650" && FROM === 0 && TO >= passes) {
			for (const shape of ["pi087", "systems"]) {
				const own = lines.filter((line) => line.includes(` ${shape} pass=`));
				const count = (key: string) =>
					own.reduce(
						(sum, line) =>
							sum + Number(new RegExp(` ${key}=(\\d+)`).exec(line)?.[1] ?? 0),
						0,
					);
				// One seeded duplicate identity: exactly one declared repair, and
				// no identity is ever repaired twice or left to recur.
				expect(count("repairs")).toBe(1);
				expect(count("recurring")).toBe(0);
				// The request-built note and the rewritten message keep the number
				// they were first served with on every pass that shows them.
				for (const key of ["note", "attached"]) {
					const numbers = own
						.map((line) => new RegExp(` ${key}=(\\d+)`).exec(line)?.[1])
						.filter((value) => value !== undefined);
					expect(numbers.length).toBeGreaterThan(0);
					expect(new Set(numbers).size).toBe(1);
				}
			}
		}
	},
	60_000,
);
