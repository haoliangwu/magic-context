import { expect, it } from "bun:test";
import { createPiFallbackIndex } from "./pi-fallback-index";
import { piMessageEntryFingerprint } from "./pi-message-identity";

type Message = {
	id: string;
	role: string;
	timestamp: number;
	content: unknown;
	call?: string;
};
const message = (index: number): Message => ({
	id: `entry-${index}`,
	role: "assistant",
	timestamp: index,
	content: [{ type: "text", text: `reply ${index}` }],
	call: `call-${index}`,
});
const update = (
	index: ReturnType<typeof createPiFallbackIndex>,
	messages: Message[],
) =>
	index.update({
		messages,
		resolveId: (msg) => msg.id,
		header: (msg) => String(msg.timestamp),
		fingerprint: piMessageEntryFingerprint,
		toolOwners: (msg, id) =>
			msg.call ? new Map([[msg.call, new Set([id])]]) : new Map(),
		reusable: new Set(messages.map((msg) => msg.id)),
	});

it("fallback index rebuilds only appended messages at 13,800 entries", () => {
	const index = createPiFallbackIndex();
	const messages = Array.from({ length: 13_800 }, (_, i) => message(i));
	update(index, messages);
	const before = index.rebuiltMessages;
	for (let i = 0; i < 64; i++) {
		messages.push(message(messages.length));
		const result = update(index, structuredClone(messages));
		expect(result.changedFrom).toBe(messages.length - 1);
		expect(result.fingerprints(new Set(["7"])).get("entry-7")).toBe(
			piMessageEntryFingerprint(messages[7]),
		);
		expect(result.owners.get(`call-${messages.length - 1}`)).toEqual(
			new Set([`entry-${messages.length - 1}`]),
		);
	}
	expect(index.rebuiltMessages - before).toBe(64);
});

it("fallback index discards stale fingerprints, positions and owner aliases on same-length extension rewrites", () => {
	const index = createPiFallbackIndex();
	const messages = Array.from({ length: 12 }, (_, i) => message(i));
	update(index, messages);
	const edited = structuredClone(messages);
	const item = edited[4];
	if (!item) throw new Error("missing fixture message");
	item.content = [{ type: "text", text: "REWRITE" }];
	item.call = "new-call";
	const result = update(index, edited);
	expect(result.changedFrom).toBe(4);
	expect(result.fingerprints(null).get(item.id)).toBe(
		piMessageEntryFingerprint(item),
	);
	expect(result.owners.has("call-4")).toBe(false);
	expect(result.owners.get("new-call")).toEqual(new Set([item.id]));
});

it("fallback index follows context_edit, reorder, deletion and fallback-to-real settlement", () => {
	for (const change of [
		(messages: Message[]) => {
			messages.splice(3, 1);
		},
		(messages: Message[]) => {
			messages.reverse();
		},
		(messages: Message[]) => {
			messages.splice(2, 4, message(40));
		},
		(messages: Message[]) => {
			const last = messages.at(-1);
			if (last) last.id = "real-settled";
		},
	]) {
		const index = createPiFallbackIndex();
		const initial = Array.from({ length: 12 }, (_, i) => message(i));
		update(index, initial);
		const current = structuredClone(initial);
		change(current);
		const incremental = update(index, current);
		const full = update(createPiFallbackIndex(), current);
		expect(incremental.fingerprints(null)).toEqual(full.fingerprints(null));
		expect(incremental.positions).toEqual(full.positions);
		expect(incremental.owners).toEqual(full.owners);
	}
});
