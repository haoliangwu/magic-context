import { describe, expect, it } from "bun:test";
import captured from "./__fixtures__/ga-host-theme.json";
import { flattenTheme } from "./sidebar-mount";
import type { V2ResolvedTheme } from "./types";

// The fixture is a recording taken off a running @opencode/cli GA host, not a
// hand-written object: an earlier mapping read `text.default` / `text.subdued`
// / `*.default`, names the theme package never had, and a fixture written in
// that same invented shape agreed with the mapping while every token fell to
// its hex fallback on the real host. A recorded shape fails instead.
type Mode = "dark" | "light";
const modes = captured.modes as Record<Mode, V2ResolvedTheme>;
const rgba = (r: number, g: number, b: number) => ({ r, g, b, a: 1 });

describe("OpenCode 2 theme mapping", () => {
    for (const mode of ["dark", "light"] as const) {
        it(`reads the host's resolved tokens on the ${mode} recording, not fallbacks`, () => {
            const host = modes[mode];
            const flat = flattenTheme(host, mode);
            expect(flat.text).toEqual(host.text?.base);
            expect(flat.textMuted).toEqual(host.text?.muted);
            expect(flat.background).toEqual(host.background?.base);
            expect(flat.borderActive).toEqual(host.border?.base);
            expect(flat.error).toEqual(host.text?.feedback?.error?.base);
            expect(flat.warning).toEqual(host.text?.feedback?.warning?.base);
            expect(flat.success).toEqual(host.text?.feedback?.success?.base);
            // Every mapped value must be a resolved colour object, never one of
            // the string fallbacks: a renamed key would fall through silently.
            for (const value of Object.values(flat)) expect(typeof value).toBe("object");
        });
    }

    it("takes the accent from hue step 200, the step the host draws its own accent in", () => {
        // On the recording, step 500 is a dark purple on the dark page and a pale
        // orange on the light page; step 200 is the readable accent in both.
        expect(flattenTheme(modes.dark, "dark").accent).toEqual(modes.dark.hue?.accent?.[200]);
        expect(flattenTheme(modes.light, "light").accent).toEqual(modes.light.hue?.accent?.[200]);
        expect(modes.dark.hue?.accent?.[200]).not.toEqual(modes.dark.hue?.accent?.[500]);
    });

    it("never falls back to white text on a light host", () => {
        const flat = flattenTheme(undefined, "light");
        expect(flat.text).not.toBe("#ffffff");
        expect(flat.background).toBe("#ffffff");
        expect(flattenTheme(undefined, "dark").text).toBe("#ffffff");
    });

    it("a hand-written object in the old invented shape gets fallbacks, proving the recording is load-bearing", () => {
        const invented = {
            text: { default: rgba(0, 0, 0), subdued: rgba(0.5, 0.5, 0.5) },
            background: { default: rgba(1, 1, 1) },
        } as unknown as V2ResolvedTheme;
        const flat = flattenTheme(invented, "light");
        expect(typeof flat.text).toBe("string");
        expect(typeof flat.background).toBe("string");
    });
});
