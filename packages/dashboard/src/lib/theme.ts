import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

/** What the person picked. "system" follows the operating system appearance. */
export type ThemePreference = "system" | "light" | "dark";
/** The palette actually painted, written to `<html data-theme>`. */
export type ResolvedTheme = "light" | "dark";

/**
 * localStorage key for the preference. public/assets/theme-boot.js reads the
 * same key before the first paint, so the two must stay identical (a unit test
 * runs the boot script and checks it agrees with this module).
 */
export const THEME_STORAGE_KEY = "magic-context-dashboard.theme";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function loadThemePreference(
  storage: Pick<Storage, "getItem"> | undefined,
): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage disabled or blocked: fall back to following the OS.
    return "system";
  }
}

export function saveThemePreference(
  storage: Pick<Storage, "setItem"> | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage full or disabled: the choice still applies for this session.
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function applyResolvedTheme(root: Pick<HTMLElement, "setAttribute">, theme: ResolvedTheme) {
  root.setAttribute("data-theme", theme);
}

export interface ThemeController {
  preference: Accessor<ThemePreference>;
  resolved: Accessor<ResolvedTheme>;
  setPreference: (preference: ThemePreference) => void;
}

interface ThemeEnvironment {
  storage?: Pick<Storage, "getItem" | "setItem">;
  matchMedia?: (query: string) => MediaQueryList;
  root?: Pick<HTMLElement, "setAttribute">;
}

function defaultEnvironment(): ThemeEnvironment {
  if (typeof window === "undefined") return {};
  let storage: ThemeEnvironment["storage"];
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    storage,
    matchMedia:
      typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined,
    root: document.documentElement,
  };
}

/**
 * Reads the OS appearance and reports later changes (the person flipping macOS,
 * Windows or GNOME between light and dark while the dashboard is open).
 * Without matchMedia the system is treated as light and never changes.
 */
export function watchSystemDark(
  matchMedia: ((query: string) => MediaQueryList) | undefined,
  onChange: (systemDark: boolean) => void,
): { initial: boolean; stop: () => void } {
  const query = matchMedia?.(SYSTEM_DARK_QUERY);
  if (!query) return { initial: false, stop: () => {} };
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return {
    initial: query.matches,
    stop: () => query.removeEventListener("change", listener),
  };
}

/**
 * Owns the theme for the app's lifetime: reads the saved preference, tracks the
 * OS appearance live (so System switches while the app is open), and keeps
 * `<html data-theme>` in sync. Must be called inside a Solid owner.
 */
export function createThemeController(
  env: ThemeEnvironment = defaultEnvironment(),
): ThemeController {
  const [preference, setPreferenceSignal] = createSignal<ThemePreference>(
    loadThemePreference(env.storage),
  );
  const [systemDark, setSystemDark] = createSignal(false);
  const watcher = watchSystemDark(env.matchMedia, setSystemDark);
  setSystemDark(watcher.initial);
  onCleanup(watcher.stop);

  const resolved = createMemo(() => resolveTheme(preference(), systemDark()));
  createEffect(() => {
    if (env.root) applyResolvedTheme(env.root, resolved());
  });

  return {
    preference,
    resolved,
    setPreference: (next) => {
      setPreferenceSignal(next);
      saveThemePreference(env.storage, next);
    },
  };
}
