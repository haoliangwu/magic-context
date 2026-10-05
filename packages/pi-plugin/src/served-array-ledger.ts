import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { log } from "@magic-context/core/shared/logger";
import type { PiLkgSerializedOutput } from "./pi-lkg";

export const PI_SERVED_ARRAY_TAIL_MESSAGES = 40;
export const PI_SERVED_ARRAY_BODY_CAPTURE_ENV =
	"MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE";
const LEDGER_DIRECTORY = "pi-served-array-digests";
const BODY_DIRECTORY = "pi-served-array-bodies";
const FLUSH_DELAY_MS = 25;

type JsonMessage = Record<string, unknown>;

export interface PiServedArrayDigestRecord {
	version: 1;
	session_id: string;
	pass_ts: string;
	sequence: number;
	message_count: number;
	sha256: string;
	previous_sha256: string | null;
	first_divergence_message_index: number | null;
	block_vector_start: number;
	block_vectors: string[];
}

interface PreviousPass {
	digest: string;
	serializedMessages: readonly string[];
}

interface CaptureOptions {
	storageDir?: string;
	now?: Date;
	fullBodyCapture?: boolean;
	/** Only the detached serialization captured from these messages in this pass. */
	serializedOutput?: PiLkgSerializedOutput;
}

const previousBySession = new Map<string, PreviousPass>();
const sequenceBySession = new Map<string, number>();
const pendingLinesByPath = new Map<string, string[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let swallowedWriteCount = 0;
let lastWriteError: string | null = null;

/** Release transcript-sized state without discarding already queued ledger rows. */
export function clearPiServedArraySession(sessionId: string): void {
	previousBySession.delete(sessionId);
	sequenceBySession.delete(sessionId);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeSessionFileStem(sessionId: string): string {
	const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	return `${readable || "session"}-${sha256(sessionId).slice(0, 12)}`;
}

export function getPiServedArrayLedgerPath(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string {
	return path.join(
		storageDir,
		LEDGER_DIRECTORY,
		`${safeSessionFileStem(sessionId)}.jsonl`,
	);
}

export function getPiServedArrayBodyPath(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string {
	return path.join(
		storageDir,
		BODY_DIRECTORY,
		`${safeSessionFileStem(sessionId)}.jsonl`,
	);
}

function fullBodyCaptureEnabled(): boolean {
	const value = process.env[PI_SERVED_ARRAY_BODY_CAPTURE_ENV]
		?.trim()
		.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function serializeMessage(message: unknown): string {
	return JSON.stringify(message) ?? "null";
}

function firstDivergence(
	previous: readonly string[],
	current: readonly string[],
): number {
	const sharedLength = Math.min(previous.length, current.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (previous[index] !== current[index]) return index;
	}
	return previous.length === current.length ? -1 : sharedLength;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

function blockVector(message: unknown): string {
	if (!message || typeof message !== "object") return "unknown:message(0)";
	const record = message as JsonMessage;
	const role = typeof record.role === "string" ? record.role : "unknown";
	const content = record.content;
	if (typeof content === "string") {
		return `${role}:text(${Buffer.byteLength(content)})`;
	}
	if (!Array.isArray(content)) {
		return `${role}:none(0)`;
	}
	if (content.length === 0) return `${role}:empty(0)`;
	const blocks = content.map((block) => {
		const type =
			block && typeof block === "object" && "type" in block
				? String((block as { type?: unknown }).type ?? "unknown")
				: typeof block;
		return `${type}(${byteLength(block)})`;
	});
	return `${role}:${blocks.join(",")}`;
}

function recordWriteFailure(error: unknown): void {
	try {
		swallowedWriteCount += 1;
		lastWriteError = error instanceof Error ? error.message : String(error);
		log("[magic-context][pi] served-array digest ledger write failed", error);
	} catch {
		// Observability must never interfere with the provider request.
	}
}

function appendPendingLines(filePath: string, lines: string[]): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const fd = fs.openSync(filePath, "a", 0o600);
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeFileSync(fd, lines.join(""), { encoding: "utf8" });
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		recordWriteFailure(error);
	}
}

/** Flush queued records. Context passes only enqueue; filesystem work runs later. */
export function flushPiServedArrayLedger(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (pendingLinesByPath.size === 0) return;
	const pending = [...pendingLinesByPath.entries()];
	pendingLinesByPath.clear();
	for (const [filePath, lines] of pending) appendPendingLines(filePath, lines);
}

function scheduleFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(flushPiServedArrayLedger, FLUSH_DELAY_MS);
	flushTimer.unref?.();
}

function enqueue(filePath: string, line: string): void {
	const pending = pendingLinesByPath.get(filePath);
	if (pending) pending.push(line);
	else pendingLinesByPath.set(filePath, [line]);
	scheduleFlush();
}

/**
 * Record the exact AgentMessage array returned to Pi for this provider pass.
 * Only a digest and the newest 40 shape vectors are retained by default; body
 * bytes are written separately only when MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE
 * is explicitly enabled.
 */
export function capturePiServedArray(
	sessionId: string,
	messages: readonly unknown[],
	options: CaptureOptions = {},
): PiServedArrayDigestRecord | undefined {
	try {
		const serializedMessages =
			options.serializedOutput?.jsonMessages ?? messages.map(serializeMessage);
		const serializedArray =
			options.serializedOutput?.json ?? `[${serializedMessages.join(",")}]`;
		const digest = sha256(serializedArray);
		const previous = previousBySession.get(sessionId);
		const divergence = previous
			? firstDivergence(previous.serializedMessages, serializedMessages)
			: null;
		const sequence = (sequenceBySession.get(sessionId) ?? 0) + 1;
		const tailStart = Math.max(
			0,
			messages.length - PI_SERVED_ARRAY_TAIL_MESSAGES,
		);
		const record: PiServedArrayDigestRecord = {
			version: 1,
			session_id: sessionId,
			pass_ts: (options.now ?? new Date()).toISOString(),
			sequence,
			message_count: messages.length,
			sha256: digest,
			previous_sha256: previous?.digest ?? null,
			first_divergence_message_index: divergence,
			block_vector_start: tailStart,
			block_vectors: messages.slice(tailStart).map(blockVector),
		};
		const storageDir = options.storageDir ?? getMagicContextStorageDir();
		enqueue(
			getPiServedArrayLedgerPath(sessionId, storageDir),
			`${JSON.stringify(record)}\n`,
		);
		if (options.fullBodyCapture ?? fullBodyCaptureEnabled()) {
			const bodyHeader = JSON.stringify({
				version: 1,
				session_id: sessionId,
				pass_ts: record.pass_ts,
				sequence,
				sha256: digest,
			});
			enqueue(
				getPiServedArrayBodyPath(sessionId, storageDir),
				`${bodyHeader.slice(0, -1)},"messages":${serializedArray}}\n`,
			);
		}
		previousBySession.set(sessionId, { digest, serializedMessages });
		sequenceBySession.set(sessionId, sequence);
		return record;
	} catch (error) {
		recordWriteFailure(error);
		return undefined;
	}
}

export const __test = {
	blockVector,
	firstDivergence,
	fullBodyCaptureEnabled,
	getDiagnostics: () => ({ swallowedWriteCount, lastWriteError }),
	reset(): void {
		flushPiServedArrayLedger();
		previousBySession.clear();
		sequenceBySession.clear();
		pendingLinesByPath.clear();
		swallowedWriteCount = 0;
		lastWriteError = null;
	},
};

process.once("beforeExit", flushPiServedArrayLedger);
