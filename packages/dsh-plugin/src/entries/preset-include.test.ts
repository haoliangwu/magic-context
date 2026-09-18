/**
 * entries/preset-include — contract test.
 *
 * The include row the thin preset emits for the SHIPPED stock composition must
 * resolve to a class that (a) IS the loader's own `Include` tree (same module
 * instance — the `EntryGroup.key` tree-carrier marker is inherited statically,
 * so the loader still recognizes the row as a file-backed subtree) and (b)
 * never writes its source file back (the loader's dispose handler would
 * otherwise truncate the shipped composition to `[]` on the first agent
 * teardown — see dsh-agent-presets' `PresetTree`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Include } from "@deepseek-ai/cordis-plugin-include";
import MagicPresetInclude, { healStaleStockPresetPath } from "./preset-include";

describe("magic preset-include entry (no-write include)", () => {
  it("is a subclass of the loader's own Include tree class", () => {
    expect(MagicPresetInclude.name).toBe("MagicPresetInclude");
    expect(Object.getPrototypeOf(MagicPresetInclude)).toBe(Include);
  });

  it("overrides write() with a no-op (shipped input, never a persistence target)", () => {
    const write = Object.getOwnPropertyDescriptor(
      MagicPresetInclude.prototype,
      "write",
    )?.value;
    expect(typeof write).toBe("function");
    // Calling it on a bare object must neither throw nor return anything.
    expect(write?.call({} as never)).toBeUndefined();
  });

  it("inherits the loader's tree-carrier marker statically", () => {
    // Include declares `static readonly [EntryGroup.key] = true`; static class
    // fields are inherited, so the loader's carrier check still passes on the
    // subclass without us importing the marker symbol ourselves.
    expect(typeof (MagicPresetInclude as unknown as Record<string, unknown>).name).toBe(
      "string",
    );
    // The static block of the parent must be visible through the subclass:
    // construct a throwaway subclass-free check — any static property the
    // parent declares is reachable via the subclass's prototype chain.
    const proto = Object.getPrototypeOf(MagicPresetInclude) as typeof Include;
    // EntryGroup.key is a symbol; the carrier marker is the only static field
    // Include declares beyond standard Function fields.
    const keys = Reflect.ownKeys(proto);
    const marker = keys.find((key) => typeof key === "symbol");
    expect(marker).toBeDefined();
    expect((proto as unknown as Record<symbol, unknown>)[marker!]).toBe(true);
    expect((MagicPresetInclude as unknown as Record<symbol, unknown>)[marker!]).toBe(true);
  });
});

describe("stale stock-preset path heal (mount-time re-location)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "preset-include-heal-"));
    tempDirs.push(dir);
    return dir;
  }

  /** Fake 0.1.5+ install tree: `dsh` package + sibling `dsh-agent-presets`. */
  function fakeInstall(root: string): { dshDir: string; stock: string } {
    const modules = join(root, "node_modules", "@deepseek-ai");
    const dshDir = join(modules, "dsh");
    const stock = join(modules, "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");
    mkdirSync(dshDir, { recursive: true });
    writeFileSync(
      join(dshDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }),
    );
    mkdirSync(dirname(stock), { recursive: true });
    writeFileSync(stock, "[]");
    return { dshDir, stock };
  }

  it("passes a healthy absolute target through untouched", () => {
    const root = tempDir();
    const { stock } = fakeInstall(root);
    const config = { path: pathToFileURL(stock).href };
    expect(healStaleStockPresetPath(config, { PATH: "" })).toEqual({ config });
  });

  it("re-locates a rotted stock-preset path at mount time", () => {
    const root = tempDir();
    const { dshDir, stock } = fakeInstall(root);
    const stale = {
      path: pathToFileURL(
        join(
          root,
          "rotted-old-store-root",
          "node_modules",
          "@deepseek-ai",
          "dsh-agent-presets",
          "presets",
          "standard",
          "agent.cordis.yml",
        ),
      ).href,
    };
    const healed = healStaleStockPresetPath(stale, {
      PATH: "",
      DSH_HOME: join(root, "no-profiles-home"),
      DSH_INSTALL_DIR: dshDir,
    });
    expect(healed.healedFrom).toBe(stale.path);
    expect(healed.config.path).toBe(pathToFileURL(stock).href);
  });

  it("never touches a missing non-stock include path", () => {
    const root = tempDir();
    const stale = { path: pathToFileURL(join(root, "mine.yml")).href };
    expect(
      healStaleStockPresetPath(stale, {
        PATH: "",
        DSH_HOME: join(root, "no-profiles-home"),
      }),
    ).toEqual({ config: stale });
  });

  it("leaves the config untouched when no live install can be located", () => {
    const root = tempDir();
    const stale = {
      path: pathToFileURL(
        join(
          root,
          "gone",
          "node_modules",
          "@deepseek-ai",
          "dsh-agent-presets",
          "presets",
          "standard",
          "agent.cordis.yml",
        ),
      ).href,
    };
    expect(
      healStaleStockPresetPath(stale, {
        PATH: "",
        DSH_HOME: join(root, "no-profiles-home"),
      }),
    ).toEqual({ config: stale });
  });
});
