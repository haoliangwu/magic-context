import { expect, test } from "bun:test";
import { measure, hasMisplacedTextTag, type Event } from "./measure";
import { sanitizeProviderError, generationSettings } from "./live-adapter";

test("provider errors redact authorization and bare credential values", () => {
    const fake = "fixture-secret-not-a-real-credential";
    const result = sanitizeProviderError(`Rejected Bearer ${fake}; raw=${fake}; alternate=sk-fixture-only`, `Bearer ${fake}`);
    expect(result).toBe("Rejected [REDACTED]; raw=[REDACTED]; alternate=[REDACTED]");
    expect(result).not.toContain(fake);
});

const raw = (messageID: string, partID: string, text: string, userTurn: number): Event => ({ kind: "raw", input: { messageID, partID }, text, userTurn });
const wire = (id: string, parts: unknown[]): Event => ({ kind: "wire", messages: [{ info: { id }, parts }] });

test("dangling mid-text tags are misplaced, but a malformed leading token is only malformed", () => {
    expect(hasMisplacedTextTag("§2§ Queued §25 until later.")).toBe(true);
    expect(hasMisplacedTextTag("§28a§ seven.")).toBe(false);
});

test("measurement reads the first subsequent real wire and independent DB number", () => {
    const events = [raw("m1", "p1", "§9§ seven", 1), wire("m1", [{ id: "p1", type: "text", text: "§2§ seven" }]),
        wire("m1", [{ id: "p1", type: "text", text: "[dropped §2§]" }])];
    const rows = measure(events, "session", "B", "fresh", () => 2);
    expect(rows[0].assignedTag).toBe(2); expect(rows[0].delta).toBe(7);
    expect(rows[0].correct).toBe(false); expect(rows[0].retagged).toBe("§2§ seven");
    expect(rows[0].byteIdentity).toBe(false);
});

test("tool-only responses use native call ownership and do not become missing-text failures", () => {
    const events: Event[] = [{ kind: "tool", input: { callID: "c", tool: "trial_echo" }, args: { text: "§8§ bad" }, userTurn: 2 },
        wire("m2", [{ type: "tool", callID: "c", state: { output: "echo" } }])];
    const rows = measure(events, "session", "A", "fresh", () => null);
    expect(rows).toHaveLength(1); expect(rows[0].messageID).toBe("m2");
    expect(rows[0].toolOnly).toBe(true); expect(rows[0].correct).toBeNull(); expect(rows[0].misplaced).toBe(true);
});

test("tag-only tool framing is misplaced even when stripping leaves an empty untagged part", () => {
    const events: Event[] = [raw("m3", "p3", "§3§", 3), { kind: "stripped", input: { partID: "p3" }, text: "" },
        { kind: "tool", input: { callID: "c" }, args: {}, userTurn: 3 },
        wire("m3", [{ id: "p3", type: "text", text: "" }, { type: "tool", callID: "c" }])];
    const row = measure(events, "session", "B", "fresh", () => null)[0];
    expect(row.tagOnlyText).toBe(true); expect(row.misplaced).toBe(true); expect(row.byteIdentity).toBe(false);
    expect(row.wellFormed).toBe(true); expect(row.canonicalPrefix).toBe(false); expect(row.malformed).toBe(false);
});

test("canonical prefix, malformed notation and incidental tags are measured separately", () => {
    const events: Event[] = [raw("good", "p1", "§2§ seven", 1), wire("good", [{ id: "p1", text: "§2§ seven" }]),
        raw("bad", "p2", "§3\"> seven §8§", 2), wire("bad", [{ id: "p2", text: "§3§ seven" }])];
    const rows = measure(events, "session", "B", "literal-head", id => id === "good" ? 2 : 3);
    expect(rows[0].correct).toBe(true); expect(rows[0].byteIdentity).toBe(true);
    expect(rows[1].malformed).toBe(true); expect(rows[1].misplaced).toBe(true); expect(rows[1].wellFormed).toBe(false);
});

test("only D enables thinking and raises the relay output cap", () => {
    for (const variant of ["A", "B", "C"] as const) expect(generationSettings(variant)).toEqual({ thinking: { type: "disabled" }, max_tokens: 512 });
    expect(generationSettings("D")).toEqual({ thinking: { type: "enabled" }, max_tokens: 4096 });
});
