import { expect, test } from "bun:test";
import { concreteTokens, evaluateV2, mergePromptV2, parseV2, preservationGate, rankCandidates, transcriptEvidence, v2Root, type V2Decision } from "./v2";
import { type Match } from "./core";

const target: Match = { id: 7, category: "CONSTANTS", source_type: "historian", created_at: 1, updated_at: 1, status: "active", lane: "semantic", score: 0.9,
    content: "Paging keeps a 64 KiB frame bound. Refuse with MC-H06 and use `paging.limit` in src/wire.ts." };
const decision = (text: string): V2Decision => ({ fact: 1, action: "merge", target: 7, reason: "Add measurement basis", claims: [{ quote: target.content, status: "keep" }], text });
test("gate rejects a dropped 64 KiB bound and falls back to new", () => {
    const result = preservationGate(decision("Paging uses UTF-8 byte sizing. Refuse with MC-H06 and use `paging.limit` in src/wire.ts."), target, "");
    expect(result.rejected).toBe(true);
    expect(result.violations).toContain("Dropped concrete token: 64 KiB");
    expect(result.effective.action).toBe("new");
    expect(result.effective.text).toBeUndefined();
});
test("gate rejects a dropped refusal code even if claims say keep", () => {
    const result = preservationGate(decision("Paging keeps a 64 KiB frame bound; use `paging.limit` in src/wire.ts."), target, "");
    expect(result.rejected).toBe(true);
    expect(result.violations).toContain("Dropped concrete token: MC-H06");
});
test("gate accepts preserved tokens and evidenced value changes only", () => {
    expect(preservationGate(decision(target.content + " Measure UTF-8 bytes."), target, "").rejected).toBe(false);
    const d = decision(target.content.replace("64 KiB", "128 KiB"));
    d.action = "update";
    d.claims = [{ quote: "Paging keeps a 64 KiB frame bound.", status: "replaced", reason: "Bound increased", evidence: "Increase the frame bound to 128 KiB." },
        { quote: "Refuse with MC-H06 and use `paging.limit` in src/wire.ts.", status: "keep" }];
    expect(preservationGate(d, target, "Increase the frame bound to 128 KiB.").rejected).toBe(false);
    expect(preservationGate(d, target, "Unrelated transcript.").rejected).toBe(true);
    d.claims[0]!.quote = "invented 64 KiB";
    expect(preservationGate(d, target, "Increase the frame bound to 128 KiB.").rejected).toBe(true);
});
test("gate requires inventory and replacement evidence and ignores non-rewrites", () => {
    const d = decision(target.content);
    d.claims = [];
    expect(preservationGate(d, target, "").rejected).toBe(true);
    d.claims = [{ quote: target.content, status: "keep" }];
    d.action = "replaces";
    expect(preservationGate(d, target, "").rejected).toBe(true);
    d.action = "new";
    expect(preservationGate(d, undefined, "").rejected).toBe(false);
});
test("concrete token extraction covers identifiers paths units codes and key boundaries", () => {
    expect(concreteTokens(target.content)).toEqual(expect.arrayContaining(["64 KiB", "MC-H06", "paging.limit", "src/wire.ts"]));
    expect(concreteTokens("storage.enforce_private_permissions sessionScopedToolsDisabled 100% 384 MiB ~/store/data.db E_REFUSED")).toEqual(expect.arrayContaining([
        "storage.enforce_private_permissions", "sessionScopedToolsDisabled", "100%", "384 MiB", "~/store/data.db", "E_REFUSED"]));
    expect(preservationGate(decision(target.content.replace("MC-H06", "MC-H060")), target, "").rejected).toBe(true);
    expect(concreteTokens("A 30-minute ceiling, 60s deadline and 5 min retry.")).toEqual(expect.arrayContaining(["30-minute", "60s", "5 min"]));
    const timeTarget = { ...target, content: "A 30-minute execution ceiling." };
    expect(preservationGate({ ...decision("A foreground execution ceiling."), claims: [{ quote: timeTarget.content, status: "keep" }] }, timeTarget, "").rejected).toBe(true);
});
test("transcript evidence excludes examples and unescapes actual lines", () => {
    expect(transcriptEvidence("<examples>old is false</examples><new_messages>A &lt; B</new_messages>")).toBe("A < B");
    expect(transcriptEvidence("<examples>old is false</examples>")).toBe("");
});
test("v2 ranking fuses ranks not unlike raw scores and caps to eight", () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({ ...target, id: i + 1, content: i === 9 ? "literal needle" : "general text", score: i === 9 ? 1000 : 0.99 - i / 100, lane: i < 15 ? "semantic" as const : "bm25" as const }));
    const extra = Array.from({ length: 10 }, (_, i) => ({ ...target, id: i + 21, content: "needle related" }));
    const ranked = rankCandidates({ category: "CONSTANTS", content: "needle" }, pool, [...pool, ...extra]);
    expect(ranked).toHaveLength(8);
    expect(ranked[0]!.id).toBe(10);
    expect(ranked[0]!.hybridScore).toBeCloseTo(1 / 70 + 1 / 61);
    expect(new Set(ranked.map(m => m.id)).size).toBe(8);
    const prompt = mergePromptV2([{ category: "CONSTANTS", content: "new rule" }], [ranked], 86400001);
    expect(prompt).toContain("## Fact 1 · CONSTANTS\nnew rule");
    expect(prompt).toContain("source: historian · age: 1.0 days");
    expect(prompt).toContain("literal needle");
    expect(prompt).not.toContain('"content":');
});
test("v2 parser requires claim list and rejects malformed statuses", () => {
    expect(parseV2(JSON.stringify([decision(target.content)]), [[target]])).toHaveLength(1);
    expect(() => parseV2('[{"fact":1,"action":"new","reason":"new"}]', [[target]])).toThrow("claims");
    const d = { ...decision(target.content), claims: [{ quote: "old", status: "omit" }] };
    expect(() => parseV2(JSON.stringify([d]), [[target]])).toThrow("Invalid claim");
    expect(parseV2("[]", [])).toEqual([]);
    expect(() => v2Root("/tmp/live")).toThrow();
    const invalid = evaluateV2('[{"fact":"copied fact text","action":"new","claims":[],"reason":"new"}]', [[target]], "");
    expect(invalid.schemaError).toContain("Invalid fact index");
    expect(invalid.gates[0]!.rejected).toBe(true);
    expect(invalid.decisions[0]!.action).toBe("new");
});
