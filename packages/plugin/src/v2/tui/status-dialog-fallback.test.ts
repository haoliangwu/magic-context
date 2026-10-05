/**
 * The v2 `/ctx-status` has two arms: the real OpenCode 1 dialog component, and
 * the plain-text dialog for a host that cannot render a component. The real
 * host lane proves the first arm paints. This file forces the second one and
 * pins why it is reachable, so the text projection cannot quietly become dead
 * code — or, worse, quietly become what every user gets because a genuine
 * defect was mistaken for a missing runtime.
 *
 * Bare Bun is exactly that no-registry host: nothing registers the
 * `opentui:runtime-module:*` virtual modules, so the compiled component's
 * imports do not resolve here.
 */
import { expect, test } from "bun:test";
import type { StatusDetail } from "../../shared/rpc-types";
import { statusText } from "./index";
import { loadCompiledStatusDialog } from "./load-compiled-status-dialog.mjs";
import { isMissingOpenTuiRuntime } from "./sidebar-mount";
import { mountV1StatusDialog } from "./status-dialog-mount";
import type { V2TuiContext } from "./types";

function context(dialog: Partial<V2TuiContext["ui"]["dialog"]>): V2TuiContext {
    return {
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
            router: { current: () => ({ type: "session", sessionID: "ses-status" }) },
            slot: () => () => {},
            toast: { show() {} },
            dialog: {
                async alert() {},
                async confirm() {
                    return false;
                },
                ...dialog,
            },
        },
    };
}

test("the compiled status dialog cannot load without the host's OpenTUI runtime registry", async () => {
    const error = await loadCompiledStatusDialog().then(
        () => undefined,
        (reason: unknown) => reason,
    );
    // If this ever resolves, the fallback arm below is unreachable and the test
    // that forces it is measuring nothing.
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain("opentui:runtime-module:");
    expect(isMissingOpenTuiRuntime(error)).toBe(true);
});

test("mountV1StatusDialog reports the missing registry as null instead of throwing", async () => {
    expect(await mountV1StatusDialog(context({ show: () => {} }))).toBeNull();
});

test("mountV1StatusDialog declines a host that publishes no component dialog surface", async () => {
    expect(await mountV1StatusDialog(context({}))).toBeNull();
});

test("the text dialog carries the status a component dialog would have drawn", () => {
    const detail = {
        usagePercentage: 42.5,
        inputTokens: 85_000,
        contextLimit: 200_000,
        historianRunning: false,
        compartmentCount: 3,
        memoryBlockCount: 2,
        memoryCount: 7,
        pendingOpsCount: 1,
        lastTransformError: null,
    } as StatusDetail;
    // Spelled out rather than computed from statusText: an expectation built by
    // the same function as the value under test agrees with it however wrong
    // both are.
    expect(statusText(detail)).toBe(
        [
            "Context: 42.5% (85K/200K tokens)",
            "Historian: idle",
            "Compartments: 3",
            "Memories: 2 injected / 7 stored",
            "Pending reductions: 1",
            "Harness: opencode2",
        ].join("\n"),
    );
});
