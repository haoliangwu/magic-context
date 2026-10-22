import { describe, expect, test } from "bun:test";
import { withoutHistorianTailCache } from "./historian-cache";

// Deliberately non-canonical JSON catches accidental parse/stringify rewrites.
const anthropicBody = String.raw`{ "model":"claude-test", "max_tokens":1e3, "system":[{"type":"text","text":"stable \\n prefix","cache_control":{"type":"ephemeral"}}], "messages":[{"role":"user","content":[{"type":"text", "text":"seed \\u0041 / chunk \ud83d\udc4b", "cache_control":{"type":"ephemeral","ttl":"5m"}}]}], "temperature":0.00 }`;
const systemOnlyBody = anthropicBody.replace(
    ', "cache_control":{"type":"ephemeral","ttl":"5m"}',
    "",
);

describe("historian wire cache markers", () => {
    test("retry retains an existing whole-tail read and fresh repair retains the system read", () => {
        const initial = JSON.parse(anthropicBody);
        const prefixes = (request: typeof initial): string[] => {
            let prefix = "";
            const marked: string[] = [];
            for (const block of [
                ...request.system,
                ...request.messages.flatMap((message: { content: unknown[] }) => message.content),
            ]) {
                prefix += block.text;
                if (block.cache_control) marked.push(prefix);
            }
            return marked;
        };
        const written = new Set(prefixes(initial));
        const retry = JSON.parse(anthropicBody);
        expect(prefixes(retry).filter((prefix) => written.has(prefix))).toHaveLength(2);
        const repair = JSON.parse(withoutHistorianTailCache(anthropicBody));
        repair.messages[0].content[0].text += "\n\nValidation error and invalid XML";
        expect(prefixes(repair).filter((prefix) => written.has(prefix))).toEqual([
            initial.system[0].text,
        ]);
        expect(repair.messages[0].content[0].cache_control).toBeUndefined();
    });
    test("splices only tail marker bytes without changing prompt or generation bytes", () => {
        expect(withoutHistorianTailCache(anthropicBody)).toBe(systemOnlyBody);
        expect(JSON.parse(systemOnlyBody).system).toEqual(JSON.parse(anthropicBody).system);
        expect(JSON.parse(systemOnlyBody).messages[0].content[0].text).toBe(
            JSON.parse(anthropicBody).messages[0].content[0].text,
        );
    });
    test("removes first, middle and sole properties, preserving other bytes", () => {
        for (const [block, expected] of [
            ['{"cache_control":{}, "type":"text","text":"x"}', '{"type":"text","text":"x"}'],
            ['{"type":"text", "cache_control":{}, "text":"x"}', '{"type":"text", "text":"x"}'],
            ['{"cache_control":{}}', "{}"],
        ]) {
            const body = JSON.stringify({
                model: "claude",
                max_tokens: 100,
                system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
                messages: [{ role: "user", content: [] }],
            }).replace('"content":[]', `"content":[${block}]`);
            expect(withoutHistorianTailCache(body)).toBe(body.replace(block, expected));
        }
    });
    test("unknown, wrapped and automatic-cache envelopes are byte-identical", () => {
        for (const body of [
            '{"model":"claude","messages":[],"max_tokens":100}',
            '{"model":"gpt","messages":[{"role":"user","content":"x"}],"max_tokens":100}',
            '{"anthropic_version":"bedrock-2023-05-31","messages":[],"system":[],"max_tokens":100}',
            '{"instances":[{"messages":[]}]}',
            anthropicBody.replace(',"cache_control":{"type":"ephemeral"}', ""),
            anthropicBody.replace('"temperature":0.00', '"cache_control":{"type":"ephemeral"}'),
        ])
            expect(withoutHistorianTailCache(body)).toBe(body);
    });
});
