/**
 * The v2 sidebar has two arms: the real OpenCode 1 component, and a plain-text
 * projection for a host that registers no OpenTUI runtime modules. The real
 * host lane proves the first arm paints. This file forces the second one and
 * pins why it is reachable, so the fallback cannot quietly become dead code —
 * or, worse, quietly become the arm every user gets because a genuine defect
 * was mistaken for a missing runtime.
 *
 * Bare Bun is exactly that no-registry host: nothing registers the
 * `opentui:runtime-module:*` virtual modules, so the compiled component's
 * imports do not resolve here.
 */
import { expect, test } from "bun:test";
import { setupWithJsx, sidebarText } from "./index";
import { loadCompiledSidebar } from "./load-compiled-sidebar.mjs";
import { isMissingOpenTuiRuntime, mountV1Sidebar } from "./sidebar-mount";
import type { V2SlotClaim, V2TuiContext } from "./types";

function fixture() {
    const claims: V2SlotClaim[] = [];
    const context: V2TuiContext = {
        location: { directory: process.cwd() },
        renderer: { requestRender() {} },
        data: {
            listen: () => () => {},
            location: { default: () => ({ directory: process.cwd() }) },
        },
        keymap: { layer: () => {} },
        storage: {
            memory: <Value extends object>(_key: string, options: { initial: Value }) =>
                [
                    options.initial,
                    (mutation: (draft: Value) => void) => mutation(options.initial),
                ] as const,
        },
        ui: {
            router: { current: () => ({ type: "session", sessionID: "ses-fallback" }) },
            slot: (claim) => {
                claims.push(claim);
                return () => {};
            },
            toast: { show() {} },
            dialog: {
                async alert() {},
                async confirm() {
                    return false;
                },
            },
        },
    };
    return { context, claims };
}

test("the compiled sidebar cannot load without the host's OpenTUI runtime registry", async () => {
    const error = await loadCompiledSidebar().then(
        () => undefined,
        (reason: unknown) => reason,
    );
    // If this ever resolves, the fallback arm below is unreachable and the test
    // that forces it is measuring nothing.
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain("opentui:runtime-module:");
    expect(isMissingOpenTuiRuntime(error)).toBe(true);
});

test("only a missing runtime registry counts as the fallback condition", () => {
    expect(isMissingOpenTuiRuntime(new Error("Cannot find package 'left-pad'"))).toBe(false);
    expect(isMissingOpenTuiRuntime(new Error("boom"))).toBe(false);
    // A real defect inside the component would arrive as an ordinary error and
    // must reach the host instead of degrading the sidebar to text.
    expect(
        isMissingOpenTuiRuntime(
            new TypeError("undefined is not a function (opentui:runtime-module:)"),
        ),
    ).toBe(false);
});

test("mountV1Sidebar reports the missing registry as null instead of throwing", async () => {
    const { context } = fixture();
    expect(await mountV1Sidebar(context, process.cwd())).toBeNull();
});

test("the sidebar.content claim renders the text projection when the component cannot mount", async () => {
    const { context, claims } = fixture();
    const cleanup = await setupWithJsx(context, (type, props) => ({ type, props }));
    try {
        const claim = claims.find((entry) => entry.append === "sidebar.content");
        if (claim?.append !== "sidebar.content") throw new Error("expected the sidebar claim");
        // Spelled out rather than computed from sidebarText: an expectation
        // built by the same function as the value under test agrees with it
        // however wrong both are.
        expect(claim.render({ sessionID: "ses-fallback" })).toEqual({
            type: "text",
            props: { children: "Magic Context · loading…" },
        });
        expect(sidebarText(undefined)).toBe("Magic Context · loading…");
    } finally {
        cleanup();
    }
});
