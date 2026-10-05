import { closeSync, opendirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

// A single JSONL line longer than this is never buffered whole. Pi stores
// pasted images inline as base64, so such lines do occur in real sessions.
const MAX_ENTRY_BYTES = 1024 * 1024;
// What an oversized line keeps: the head holds Pi's leading entry keys (type,
// id, parentId, timestamp, message role, tool call id); the tail holds the
// message's trailing keys (timestamp, stopReason).
const OVERSIZED_HEAD_BYTES = 64 * 1024;
const OVERSIZED_TAIL_BYTES = 4 * 1024;

/**
 * An entry line too large to buffer, reduced to a content-free stand-in.
 *
 * Skipping it would shift every later ordinal against Pi's own loader, which
 * parses the line in full. So it becomes a stub of the same entry type, id and
 * message role with empty content: it keeps its ordinal and branch position,
 * and only its content (usually image data) is lost.
 */
class OversizedLine {
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private bytes = 0;

	append(piece: Buffer): this {
		this.bytes += piece.length;
		if (this.head.length < OVERSIZED_HEAD_BYTES) {
			this.head = Buffer.concat([
				this.head,
				piece.subarray(0, OVERSIZED_HEAD_BYTES - this.head.length),
			]);
		}
		const joined = Buffer.concat([this.tail, piece]);
		this.tail = Buffer.from(
			joined.subarray(Math.max(0, joined.length - OVERSIZED_TAIL_BYTES)),
		);
		return this;
	}

	/** The stub as a JSON line, or "" (skipped like any malformed line) if this is not a Pi entry. */
	stub(): string {
		const head = this.head.toString("utf8");
		const tail = this.tail.toString("utf8");
		const type = /^\{"type":"([^"\\]+)"/.exec(head)?.[1];
		if (!type) return "";
		const messageAt = head.indexOf('"message":{');
		const entryHead = messageAt >= 0 ? head.slice(0, messageAt) : head;
		const stub: Record<string, unknown> = {
			type,
			magicContextOmittedBytes: this.bytes,
		};
		const id = /"id":"([^"\\]+)"/.exec(entryHead)?.[1];
		if (id) stub.id = id;
		const parent = /"parentId":(?:null|"([^"\\]+)")/.exec(entryHead);
		if (parent) stub.parentId = parent[1] ?? null;
		const timestamp = /"timestamp":"([^"\\]+)"/.exec(entryHead)?.[1];
		if (timestamp) stub.timestamp = timestamp;
		if (type === "message" && messageAt >= 0) {
			const messageHead = head.slice(messageAt);
			const role = /^"message":\{"role":"([^"\\]+)"/.exec(messageHead)?.[1];
			if (role) {
				const message: Record<string, unknown> = { role, content: [] };
				const toolCallId = /"toolCallId":"([^"\\]+)"/.exec(messageHead)?.[1];
				if (toolCallId) message.toolCallId = toolCallId;
				const toolName = /"toolName":"([^"\\]+)"/.exec(messageHead)?.[1];
				if (toolName) message.toolName = toolName;
				const stopReason = lastMatch(tail, /"stopReason":"([^"\\]+)"/g);
				if (stopReason) message.stopReason = stopReason;
				const messageTime = lastMatch(tail, /"timestamp":(\d+)/g);
				if (messageTime) message.timestamp = Number(messageTime);
				stub.message = message;
			}
		}
		return JSON.stringify(stub);
	}
}

function lastMatch(text: string, pattern: RegExp): string | undefined {
	let last: string | undefined;
	for (const match of text.matchAll(pattern)) last = match[1];
	return last;
}

export function* lines(path: string): Generator<string> {
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(64 * 1024);
	let pending = Buffer.alloc(0);
	let oversized: OversizedLine | null = null;
	try {
		while (true) {
			const bytes = readSync(fd, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			let start = 0;
			for (let i = 0; i < bytes; i++) {
				if (buffer[i] !== 10) continue;
				const piece = buffer.subarray(start, i);
				if (oversized) {
					yield oversized.append(piece).stub();
					oversized = null;
				} else if (pending.length + piece.length > MAX_ENTRY_BYTES) {
					yield new OversizedLine().append(pending).append(piece).stub();
				} else {
					yield Buffer.concat([pending, piece]).toString("utf8");
				}
				pending = Buffer.alloc(0);
				start = i + 1;
			}
			const rest = buffer.subarray(start, bytes);
			if (oversized) {
				oversized.append(rest);
			} else if (pending.length + rest.length > MAX_ENTRY_BYTES) {
				oversized = new OversizedLine().append(pending).append(rest);
				pending = Buffer.alloc(0);
			} else {
				pending = Buffer.concat([pending, rest]);
			}
		}
		if (oversized) yield oversized.stub();
		else if (pending.length) yield pending.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function* sessionFiles(
	directory: string,
	nested: boolean,
): Generator<string> {
	let dir: ReturnType<typeof opendirSync>;
	try {
		dir = opendirSync(directory);
	} catch {
		return;
	}
	try {
		while (true) {
			const entry = dir.readSync();
			if (!entry) break;
			const path = join(directory, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
			else if (nested && entry.isDirectory()) yield* sessionFiles(path, false);
		}
	} finally {
		dir.closeSync();
	}
}

/** Discovery reads only one bounded header per file, never listAll's transcript previews. */
export function findSession(
	directory: string,
	nested: boolean,
	sessionId: string,
): string | null {
	for (const header of sessionHeaders(directory, nested)) {
		if (header.id === sessionId) return header.path;
	}
	return null;
}

export function* sessionHeaders(
	directory: string,
	nested: boolean,
): Generator<Record<string, unknown> & { path: string }> {
	for (const path of sessionFiles(directory, nested)) {
		try {
			for (const line of lines(path)) {
				const header = record(JSON.parse(line));
				if (header.type === "session") yield { ...header, path };
				break;
			}
		} catch {
			/* Unreadable or malformed headers are not candidates. */
		}
	}
}

export function* sessionEntries(path: string): Generator<unknown> {
	for (const line of lines(path)) {
		try {
			yield JSON.parse(line);
		} catch {
			/* Match Pi's tolerant JSONL parser. */
		}
	}
}
