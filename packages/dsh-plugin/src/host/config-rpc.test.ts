/**
 * host/config-rpc tests — `magicContext/config` + `magicContext/config-save`
 * host surface: raw read semantics, JSONC + schema gates, the unparseable-file
 * save guard, and the atomic same-directory write. Kept dependency-free: paths
 * are passed explicitly (except one default-path wiring test that redirects
 * XDG_CONFIG_HOME to a temp dir).
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/remote-seam";
import {
  MAGIC_CONFIG_METHOD,
  MAGIC_CONFIG_SAVE_METHOD,
  magicConfigDescriptor,
  magicConfigSaveDescriptor,
} from "./remote";
import { readUserConfig, saveUserConfig } from "./config-rpc";

function tempConfigPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-config-test-"));
  return { dir, path: join(dir, "cortexkit", "magic-context.jsonc") };
}

const VALID_JSONC = `{
  // user comment
  "enabled": true,
  "memory": { "enabled": true, },
}`;

describe("readUserConfig", () => {
  it("reports a missing file as exists:false with empty content", () => {
    const { dir, path } = tempConfigPath();
    const result = readUserConfig(path);
    expect(result.path).toBe(path);
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
    expect(result.parseError).toBeUndefined();
    expect(result.readError).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    // Path is explicit; no hidden dep on host env.
    expect(dir).toContain("dsh-magic-config-test-");
  });

  it("returns the raw file text for a valid JSONC file", () => {
    const { path } = tempConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, VALID_JSONC);
    const result = readUserConfig(path);
    expect(result.exists).toBe(true);
    expect(result.content).toBe(VALID_JSONC);
    expect(result.parseError).toBeUndefined();
  });

  it("returns content plus parseError for an unparseable file", () => {
    const { path } = tempConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json: ");
    const result = readUserConfig(path);
    expect(result.exists).toBe(true);
    expect(result.content).toBe("{ not json: ");
    expect(result.parseError).toBeDefined();
  });

  it("surfaces a read failure without pretending the file is missing", () => {
    const { dir, path } = tempConfigPath();
    // A directory at the config path exists but cannot be read as text.
    mkdirSync(path, { recursive: true });
    const result = readUserConfig(path);
    expect(result.exists).toBe(true);
    expect(result.readError).toBeDefined();
    expect(dir).toContain("dsh-magic-config-test-");
  });
});

describe("saveUserConfig", () => {
  it("writes atomically (parent dirs created) and round-trips content", () => {
    const { dir, path } = tempConfigPath();
    const deep = join(dir, "a", "deep", "nested", "magic-context.jsonc");
    const result = saveUserConfig(VALID_JSONC, deep);
    expect(result.ok).toBe(true);
    expect(readFileSync(deep, "utf-8")).toBe(VALID_JSONC);
    expect(readdirSync(join(dir, "a", "deep", "nested"))).toEqual(["magic-context.jsonc"]);
    const reread = readUserConfig(deep);
    expect(reread.exists).toBe(true);
    expect(reread.content).toBe(VALID_JSONC);
  });

  it("preserves unknown top-level keys byte-exact (stored raw, not rewritten)", () => {
    const { path } = tempConfigPath();
    const withUnknown = `{
  "enabled": true,
  "future_key": { "nested": [1, 2] },
}`;
    const result = saveUserConfig(withUnknown, path);
    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(withUnknown);
  });

  it("refuses when the existing file is unparseable, leaving it untouched", () => {
    const { path } = tempConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ broken: ");
    const result = saveUserConfig(VALID_JSONC, path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSONC/);
    expect(result.error).toMatch(/refusing/);
    expect(readFileSync(path, "utf-8")).toBe("{ broken: ");
  });

  it("refuses invalid JSONC input", () => {
    const { path } = tempConfigPath();
    const result = saveUserConfig("{ oops", path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSONC/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a top-level array (config must be an object)", () => {
    const { path } = tempConfigPath();
    const result = saveUserConfig("[1, 2, 3]", path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/object/);
  });

  it("refuses schema-invalid values", () => {
    const { path } = tempConfigPath();
    const result = saveUserConfig('{ "execute_threshold_percentage": 999 }', path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not validate/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a non-string content argument", () => {
    const { path } = tempConfigPath();
    const result = saveUserConfig(42 as unknown as string, path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be a string/);
  });
});

describe("default-path wiring (XDG_CONFIG_HOME redirect)", () => {
  it("reads and saves through the resolved CortexKit user path", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-magic-config-home-"));
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const missing = readUserConfig();
      expect(missing.exists).toBe(false);
      expect(missing.content).toBe("");
      expect(missing.path).toBe(join(home, "cortexkit", "magic-context.jsonc"));

      const saved = saveUserConfig(VALID_JSONC);
      expect(saved.ok).toBe(true);

      const reread = readUserConfig();
      expect(reread.exists).toBe(true);
      expect(reread.content).toBe(VALID_JSONC);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("magicContext config descriptors", () => {
  it("carry the strict namespace, direct invocation, and src-json wire", () => {
    for (const descriptor of [magicConfigDescriptor(), magicConfigSaveDescriptor()]) {
      expect(descriptor.namespace).toBe(MAGIC_CONTEXT_REMOTE_NAMESPACE);
      expect(descriptor.service).toBe("magicContextRemote");
      expect(descriptor.invocation.kind).toBe("direct");
      expect(descriptor.result).toEqual({ mode: "src-json" });
      expect(descriptor.parameters.length).toBe(1);
      const parameter = descriptor.parameters[0];
      expect(parameter?.name).toBe("args");
      expect(parameter?.wire).toBe("args");
      expect(parameter?.codec.mode).toBe("src-json");
    }
    expect(magicConfigDescriptor().method).toBe(MAGIC_CONFIG_METHOD);
    expect(magicConfigSaveDescriptor().method).toBe(MAGIC_CONFIG_SAVE_METHOD);
    expect(magicConfigDescriptor().id).toBe("magicContext.config");
    expect(magicConfigSaveDescriptor().id).toBe("magicContext.config-save");
  });
});