import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadThemePreference,
  type ResolvedTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  saveThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
  watchSystemDark,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function fakeMediaQuery(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  const list = {
    matches,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList;
  return {
    listeners,
    queries,
    matchMedia: (query: string) => {
      queries.push(query);
      return list;
    },
    fire: (next: boolean) => {
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe("theme preference", () => {
  it("defaults to System when nothing (or garbage) is stored", () => {
    expect(loadThemePreference(memoryStorage())).toBe("system");
    expect(loadThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("system");
    expect(loadThemePreference(undefined)).toBe("system");
  });

  it("falls back to System when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadThemePreference(throwing)).toBe("system");
  });

  it("round-trips each choice through storage", () => {
    const storage = memoryStorage();
    for (const preference of ["light", "dark", "system"] as const) {
      saveThemePreference(storage, preference);
      expect(storage.data.get(THEME_STORAGE_KEY)).toBe(preference);
      expect(loadThemePreference(storage)).toBe(preference);
    }
  });

  it("System follows the OS; explicit choices ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("watchSystemDark", () => {
  it("reports the current appearance and every later OS switch until stopped", () => {
    const media = fakeMediaQuery(true);
    const seen: boolean[] = [];
    const watcher = watchSystemDark(media.matchMedia, (dark) => seen.push(dark));
    expect(media.queries).toEqual([SYSTEM_DARK_QUERY]);
    expect(watcher.initial).toBe(true);
    media.fire(false);
    media.fire(true);
    expect(seen).toEqual([false, true]);
    watcher.stop();
    expect(media.listeners.size).toBe(0);
    media.fire(false);
    expect(seen).toEqual([false, true]);
  });

  it("treats a runtime without matchMedia as light", () => {
    const watcher = watchSystemDark(undefined, () => {});
    expect(watcher.initial).toBe(false);
  });
});

describe("theme-boot.js (runs before the app bundle)", () => {
  const source = readFileSync(
    resolve(import.meta.dir, "../../public/assets/theme-boot.js"),
    "utf8",
  );

  function runBoot(stored: string | null, systemDark: boolean | undefined): string | null {
    let applied: string | null = null;
    const window = {
      localStorage: { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) },
      matchMedia:
        systemDark === undefined
          ? undefined
          : (query: string) => ({ matches: query === SYSTEM_DARK_QUERY && systemDark }),
    };
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          if (name === "data-theme") applied = value;
        },
      },
    };
    new Function("window", "document", source)(window, document);
    return applied;
  }

  it("uses the same storage key and media query as the app", () => {
    expect(source).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(source).toContain(JSON.stringify(SYSTEM_DARK_QUERY));
  });

  it("paints exactly what the app resolves for every stored value and OS appearance", () => {
    const stored: (string | null)[] = [null, "system", "light", "dark", "bogus"];
    for (const value of stored) {
      for (const systemDark of [true, false]) {
        const expected: ResolvedTheme = resolveTheme(
          loadThemePreference({ getItem: () => value }) as ThemePreference,
          systemDark,
        );
        expect(runBoot(value, systemDark)).toBe(expected);
      }
    }
    expect(runBoot(null, undefined)).toBe("light");
  });

  it("still applies a theme when storage throws", () => {
    let applied: string | null = null;
    const window = {
      get localStorage(): Storage {
        throw new Error("denied");
      },
      matchMedia: () => ({ matches: true }),
    };
    const document = {
      documentElement: { setAttribute: (_n: string, value: string) => (applied = value) },
    };
    new Function("window", "document", source)(window, document);
    expect(applied as string | null).toBe("dark");
  });
});
