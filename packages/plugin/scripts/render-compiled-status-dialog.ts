/**
 * Renders the shipped, compiled `/ctx-status` dialog
 * (`src/tui-compiled/dialogs/status-dialog.tsx`) outside OpenCode, for
 * `src/tui/dialogs/status-dialog-render.test.ts`.
 *
 * The compiled component imports its runtime from OpenCode's process-wide
 * `opentui:runtime-module:*` registry. Bare Bun has none, so this script
 * registers the same modules from this package's own dependencies. A Bun
 * plugin cannot be unregistered, which is why this runs as its own process:
 * other tests in the suite check that the registry is absent.
 *
 * Run it with `bun --conditions=browser`. Without that condition Bun resolves
 * `solid-js` to its server build, where signals never re-run anything, so the
 * frame would show only the dialog's first, pre-layout pass and never the
 * update it makes once it knows its own width. OpenCode runs the reactive
 * build.
 *
 * Input (stdin): a JSON array of render cases, each
 * `{ status, terminalWidth?, dialogWidth? }`. `status` is a checked status
 * result. `terminalWidth` is the test terminal's width (default 110).
 * `dialogWidth`, when set, puts the dialog inside a box of that many columns
 * (capped at `terminalWidth - 2`), the way OpenCode's dialog surface hosts it;
 * without it the dialog fills the terminal.
 *
 * Output (stdout): a JSON array with, for each input, either `{ frame }` (the
 * rendered characters) or `{ error }` (the message the render threw).
 */
import { plugin } from "bun";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";

type TestRender = (
    node: () => unknown,
    options: { width: number; height: number },
) => Promise<{ renderOnce(): Promise<void>; captureCharFrame(): string }>;

type Reconciler = {
    createElement(tag: string): unknown;
    setProp(node: unknown, name: string, value: unknown): unknown;
    insert(parent: unknown, accessor: () => unknown): unknown;
    createComponent(component: (props: unknown) => unknown, props: unknown): unknown;
};

type RenderCase = { status: unknown; terminalWidth?: number; dialogWidth?: number };

const DEFAULT_TERMINAL_WIDTH = 110;

const loaded = new Map<string, Record<string, unknown>>();
for (const specifier of TUI_RUNTIME_SPECIFIERS) loaded.set(specifier, await import(specifier));
plugin({
    name: "opentui-runtime-registry-for-render-script",
    setup(build) {
        for (const specifier of TUI_RUNTIME_SPECIFIERS) {
            build.module(runtimeModuleId(specifier), () => ({
                exports: loaded.get(specifier) ?? {},
                loader: "object",
            }));
        }
    },
});

const openTuiSolid = loaded.get("@opentui/solid") as unknown as { testRender: TestRender } & Reconciler;
const { testRender } = openTuiSolid;
// Imported by URL so the scripts typecheck does not try to compile the TSX
// output (it is already transformed and has no JSX left in it).
const dialogUrl = new URL("../src/tui-compiled/dialogs/status-dialog.tsx", import.meta.url).href;
const dialog = (await import(dialogUrl)) as {
    StatusDialog(props: { api: unknown; status: unknown }): unknown;
};
const theme = {
    accent: "#ffcc00",
    text: "#ffffff",
    textMuted: "#888888",
    warning: "#ff8800",
    error: "#ff0000",
};

/**
 * The dialog, optionally inside a fixed-width column standing in for the
 * host's dialog surface. OpenCode sizes that surface itself (60 columns by
 * default, never wider than the terminal minus 2), and the dialog has to fit
 * whatever width it is given.
 */
function mount(entry: RenderCase, terminalWidth: number): () => unknown {
    const props = { api: { theme: { current: theme } }, status: entry.status };
    if (entry.dialogWidth === undefined) return () => dialog.StatusDialog(props);
    const dialogWidth = entry.dialogWidth;
    return () => {
        const surface = openTuiSolid.createElement("box");
        openTuiSolid.setProp(surface, "flexDirection", "column");
        openTuiSolid.setProp(surface, "width", dialogWidth);
        openTuiSolid.setProp(surface, "maxWidth", terminalWidth - 2);
        openTuiSolid.insert(surface, () =>
            openTuiSolid.createComponent(
                dialog.StatusDialog as (props: unknown) => unknown,
                props,
            ),
        );
        return surface;
    };
}

const inputs = JSON.parse(await Bun.stdin.text()) as RenderCase[];
const results: Array<{ frame: string } | { error: string }> = [];
for (const entry of inputs) {
    try {
        const terminalWidth = entry.terminalWidth ?? DEFAULT_TERMINAL_WIDTH;
        const setup = await testRender(mount(entry, terminalWidth), {
            width: terminalWidth,
            height: 60,
        });
        // The first pass lays the dialog out before it knows its own width; the
        // passes after it draw what the dialog chose once it had measured
        // itself, which is the frame a user actually sees.
        for (let pass = 0; pass < 3; pass += 1) await setup.renderOnce();
        results.push({ frame: setup.captureCharFrame() });
    } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
    }
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
