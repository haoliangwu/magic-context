import { describe, expect, it } from "bun:test";
import { configDefault, configSchemaNode, defaultPlaceholder } from "./config-schema";

describe("editor schema defaults", () => {
  it("uses the schema score, timeout, and optional derived values", () => {
    expect(configDefault("memory.auto_search.score_threshold")).toBe(0.6);
    expect(defaultPlaceholder("historian_timeout_ms")).toBe("Default: 600000");
    expect(defaultPlaceholder("cache_ttl")).toBe("Default: 5m");
    expect(configDefault("output_reserve")).toBeUndefined();
    expect(configDefault("allow_home_project")).toBe(false);
  });

  it("honors task object defaults ahead of the generic empty cron leaf default", () => {
    expect(configDefault("dreamer.tasks.verify.schedule")).toBe("0 3 * * *");
    expect(configDefault("dreamer.tasks.maintain-docs.schedule")).toBe("");
    expect(configDefault("dreamer.tasks.promote-primers.promotion_threshold")).toBe(2);
  });

  it("uses schema SQLite bounds", () => {
    expect(configSchemaNode("sqlite.cache_size_mb")?.minimum).toBe(2);
    expect(configSchemaNode("sqlite.cache_size_mb")?.maximum).toBe(2048);
    expect(configSchemaNode("sqlite.mmap_size_mb")?.maximum).toBe(8192);
  });
});
