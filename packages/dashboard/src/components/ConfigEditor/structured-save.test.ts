import { describe, expect, it } from "bun:test";
import { parse } from "comment-json";
import { parseJsonc } from "../../lib/jsonc";
import { structuredConfigSaveContent } from "./structured-save";

const commentedConfig = `{
  // keep this file under dotfiles
  "enabled": true,
  "embedding": {
    /* provider notes */
    "provider": "openai-compatible",
    "api_key": "{env:EMBED_KEY}" // never commit the key
  },
  "protected_tokens": 20000,
  "language": "en",
  // unknown keys stay
  "custom": [1, /* two */ 2]
}
`;

describe("structured config form save", () => {
  it("adding an override preserves every existing byte, including trailing commas and unusual spacing", () => {
    const source =
      '{\r\n\t// Keep the operator comment.\r\n\t"future" : { "spacing" :  42, },\r\n}\r\n';
    expect(structuredConfigSaveContent(source, { ...parseJsonc(source), language: "tr" })).toBe(
      source.replace("\r\n}\r\n", '\r\n\t"language": "tr",\r\n}\r\n'),
    );
    const inline = '{ /* keep */ "unknown" :  1, }';
    expect(structuredConfigSaveContent(inline, { ...parseJsonc(inline), enabled: true })).toBe(
      '{ /* keep */ "unknown" :  1, "enabled": true, }',
    );
    const noComma = '{"a":1 // keep this comment with a\n}\n';
    expect(structuredConfigSaveContent(noComma, { ...parseJsonc(noComma), language: "tr" })).toBe(
      '{"a":1, // keep this comment with a\n  "language": "tr"\n}\n',
    );
    const inlineComment = '{"a":1 /* keep */ }';
    expect(
      structuredConfigSaveContent(inlineComment, { ...parseJsonc(inlineComment), language: "tr" }),
    ).toBe('{"a":1, /* keep */ "language": "tr" }');
  });
  // The save path is a pure string transform, so the round trip needs no file:
  // CRLF, tabs, comments and the trailing comma must all survive untouched.
  it("round-trips JSONC text byte-for-byte except changed value tokens", () => {
    const original =
      '{\r\n\t// dotfiles formatting stays\r\n\t"enabled" : true,\r\n\t"cache_ttl": { "default" : "5m", /* model note */ "provider/model": "1h" },\r\n\t"dreamer": {"tasks": { "verify": {"schedule" : "0 3 * * *"} }},\r\n\t"unknown" : [1, /* keep */ 2],\r\n}\r\n';
    const form = structuredClone(parseJsonc(original));
    (form.cache_ttl as Record<string, unknown>)["provider/model"] = "never";
    const dreamer = form.dreamer as { tasks: { verify: { schedule: string } } };
    dreamer.tasks.verify.schedule = "";
    expect(structuredConfigSaveContent(original, form)).toBe(
      original.replace('"1h"', '"never"').replace('"0 3 * * *"', '""'),
    );
  });

  it("leaves an unchanged file completely untouched, including trailing whitespace", () => {
    const source = '\n{ "enabled":true, /* keep */ "future": 1, }\t\n\n';
    expect(structuredConfigSaveContent(source, structuredClone(parseJsonc(source)))).toBe(source);
  });
  it("#given a commented config #when one form field changes #then every comment survives", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.protected_tokens = 30000;
    (form.embedding as Record<string, unknown>).model = "text-embedding-3-small";

    const saved = structuredConfigSaveContent(commentedConfig, form);

    expect(saved).toContain("// keep this file under dotfiles");
    expect(saved).toContain("/* provider notes */");
    expect(saved).toContain("// never commit the key");
    expect(saved).toContain("// unknown keys stay");
    expect(saved).toContain("/* two */");
    const parsed = parse(saved) as Record<string, unknown>;
    expect(parsed.protected_tokens).toBe(30000);
    expect(parsed.embedding).toEqual({
      provider: "openai-compatible",
      api_key: "{env:EMBED_KEY}",
      model: "text-embedding-3-small",
    });
  });

  it("#given a field cleared in the form #when saving #then the key is removed like before", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.language = undefined;

    const parsed = parse(structuredConfigSaveContent(commentedConfig, form)) as Record<
      string,
      unknown
    >;

    expect("language" in parsed).toBe(false);
    expect(parsed.enabled).toBe(true);
  });

  it("#given form data that omits a section's sub-keys #when saving #then those sub-keys are kept", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.embedding = { provider: "local" };

    const parsed = parse(structuredConfigSaveContent(commentedConfig, form)) as Record<
      string,
      unknown
    >;

    expect(parsed.embedding).toEqual({ provider: "local", api_key: "{env:EMBED_KEY}" });
  });

  it("#given no existing file #when saving #then a fresh config is written", () => {
    const parsed = parse(structuredConfigSaveContent("", { enabled: false })) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ enabled: false });
  });
});
