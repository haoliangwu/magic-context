import type { SidebarSnapshot } from "../../shared/rpc-types";

export interface V2TuiLocation {
    readonly directory: string;
}

export interface V2TuiRoute {
    readonly type: string;
    readonly sessionID?: string;
}

/**
 * One resolved colour from the OpenCode 2 theme. `@opentui/core`'s RGBA keeps
 * its channels as 0..1 floats; only those four fields are read here, so the
 * shape is declared structurally instead of depending on the optional
 * `@opencode/theme` peer package (it is not installed in this workspace).
 */
export interface V2ThemeColor {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
}

/**
 * The part of `@opencode/theme/tui`'s `ResolvedTheme` the sidebar reads. Every
 * level is optional because the plugin must still paint on a host whose theme
 * resolves a different token set than the pinned 2.0.5 one.
 */
/**
 * The part of `@opencode/theme/tui`'s `ResolvedThemeTokens` the sidebar and the
 * status dialog read, with the key names from the published 2.0.11 declaration
 * (`dist/tui/types.d.ts`): `text.base` / `text.muted`, `text.feedback.<kind>.base`
 * for `error` / `warning` / `success` / `info`, `hue.<name>[step]` with steps
 * 100..900 and the `accent` alias, `background.base`, `border.base`. Every level
 * is optional because the plugin must still paint on a host whose theme resolves
 * a different token set.
 */
export interface V2ResolvedTheme {
    readonly hue?: Readonly<Record<string, Readonly<Record<string, V2ThemeColor>>>>;
    readonly text?: {
        readonly base?: V2ThemeColor;
        readonly muted?: V2ThemeColor;
        readonly feedback?: Readonly<Record<string, { readonly base?: V2ThemeColor }>>;
    };
    readonly background?: { readonly base?: V2ThemeColor };
    readonly border?: { readonly base?: V2ThemeColor };
}

export interface V2TuiContext {
    readonly location?: V2TuiLocation;
    readonly renderer: { requestRender(): void };
    /** `Context.theme` on GA 2.0.5/2.0.11; absent on hosts that publish no theme. */
    readonly theme?: V2ResolvedTheme;
    /** `Context.themeMode` on GA 2.0.5/2.0.11; picks readable fallbacks when a token is missing. */
    readonly themeMode?: "dark" | "light";
    readonly data: {
        readonly listen: (handler: (event: { details: unknown }) => void) => () => void;
        readonly location: { default(): V2TuiLocation };
        /**
         * `Context.data.session` on GA 2.0.x. `location.directory` is the
         * directory whose Magic Context server owns the session. Optional so a
         * host without it falls back to the startup directory.
         */
        readonly session?: {
            get(
                sessionID: string,
            ): { readonly location?: { readonly directory?: string } } | undefined;
        };
    };
    readonly keymap: {
        readonly layer: (
            input: () => {
                readonly mode?: string;
                readonly commands: ReadonlyArray<{
                    readonly id: string;
                    readonly title: string;
                    readonly group: string;
                    readonly palette: true;
                    readonly slash: { readonly name: string; readonly arguments?: true };
                    readonly run: (input?: string) => void | Promise<void>;
                }>;
            },
        ) => void;
    };
    readonly storage: {
        readonly memory: <Value extends object>(
            key: string,
            options: { readonly initial: Value },
        ) => readonly [Value, (mutation: (draft: Value) => void) => void];
    };
    readonly ui: {
        readonly router: { current(): V2TuiRoute };
        readonly slot: (claim: V2SlotClaim) => () => void;
        readonly toast: {
            show(options: {
                readonly title?: string;
                readonly message: string;
                readonly variant?: "info" | "success" | "warning" | "error";
                readonly duration?: number;
            }): void;
        };
        readonly dialog: {
            /**
             * Renders a plugin-owned component as the dialog surface. GA 2.0.5
             * and 2.0.11 publish it next to alert/confirm/prompt; it is optional
             * here so a host without it still gets the text dialog.
             */
            show?(component: () => unknown, onClose?: () => void): void;
            /** Sizes the dialog surface before `show`; "medium" is the host default. */
            set?(options: { readonly size?: string; readonly centered?: boolean }): void;
            alert(options: { readonly title: string; readonly message: string }): Promise<void>;
            confirm(options: {
                readonly title: string;
                readonly message: string;
                readonly label?: { readonly confirm?: string; readonly cancel?: string };
            }): Promise<boolean | undefined>;
        };
    };
}

/**
 * A slot claim's `render` runs inside the host's component tree; `app` is the
 * always-mounted root slot, which is where `keymap.layer()` can be called from
 * when plugin `setup()` runs outside the keymap provider (see index.ts).
 */
export type V2SlotClaim =
    | {
          readonly append: "sidebar.content";
          readonly render: (input: { readonly sessionID: string }) => unknown;
      }
    | {
          readonly append: "app";
          readonly render: (input: Readonly<Record<string, never>>) => unknown;
      };

/** The layer object `context.keymap.layer()` accepts, derived from the context type. */
export type V2KeymapLayer = ReturnType<Parameters<V2TuiContext["keymap"]["layer"]>[0]>;

export interface V2SidebarState {
    snapshots: Record<string, SidebarSnapshot | undefined>;
}
