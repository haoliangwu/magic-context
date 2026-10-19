/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { replaySentinelByMessageIds } from "./sentinel";
import { stripDroppedPlaceholderMessages, stripSystemInjectedMessages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

// OpenCode 2 hands host system updates (and other plugins' reminders) to the
// transform as `system` rows. Its Anthropic adapter sends such a row as an
// in-conversation system message with its text blocks as they are, so the empty
// sentinel that user/assistant rows get would be an empty text block, which the
// API rejects with HTTP 400. These tests pin the whole-message lanes: a system
// row on canonical Anthropic is left with no parts (the payload commit then
// omits it), and every other shape keeps exactly the bytes it had before.

function message(id: string, role: string, text: string): MessageLike {
    return { info: { id, role, sessionID: "ses-1" }, parts: [{ type: "text", text }] };
}

const REMINDER = "<system-reminder>Background task finished.</system-reminder>";

/** A session where every whole-message lane has something to neutralize. */
function session(): MessageLike[] {
    return [
        message("u1", "user", "§1§ start"),
        message("s-marker", "system", "[dropped §2§]"),
        message("s-reminder", "system", REMINDER),
        message("a-marker", "assistant", "[dropped §3§]"),
        message("a-reminder", "assistant", REMINDER),
        message("u2", "user", "§4§ next"),
    ];
}

/** One rebuilding pass: detect both lanes, as transform-postprocess-phase does. */
function detect(messages: MessageLike[], providerID?: string): string[] {
    const dropped = stripDroppedPlaceholderMessages(messages, providerID);
    const injected = stripSystemInjectedMessages(messages, messages.length, providerID);
    return [...dropped.sentineledIds, ...injected.sentineledIds];
}

const byId = (messages: MessageLike[]) =>
    Object.fromEntries(messages.map((entry) => [entry.info.id, entry.parts]));

describe("whole-message neutralization of OpenCode 2 system rows", () => {
    it("leaves an Anthropic system row with no parts on both detecting lanes", () => {
        const messages = session();
        const ids = detect(messages, "anthropic");
        expect(ids.sort()).toEqual(["a-marker", "a-reminder", "s-marker", "s-reminder"]);
        expect(byId(messages)).toEqual({
            u1: [{ type: "text", text: "§1§ start" }],
            "s-marker": [],
            "s-reminder": [],
            "a-marker": [{ type: "text", text: "" }],
            "a-reminder": [{ type: "text", text: "" }],
            u2: [{ type: "text", text: "§4§ next" }],
        });
        // The message objects stay in the array, so later index-addressed lanes line up.
        expect(messages).toHaveLength(6);
    });

    it("keeps the [dropped] row for every provider that does not use empty sentinels", () => {
        for (const providerID of [undefined, "openai", "google-vertex-anthropic"]) {
            const messages = session();
            detect(messages, providerID);
            const dropped = [{ type: "text", text: "[dropped]" }];
            expect(byId(messages)).toMatchObject({
                "s-marker": dropped,
                "s-reminder": dropped,
                "a-marker": dropped,
                "a-reminder": dropped,
            });
        }
    });

    it("replays a persisted decision to the same shape the detecting pass produced", () => {
        const detected = session();
        const ids = new Set(detect(detected, "anthropic"));
        const replayed = session();
        const result = replaySentinelByMessageIds(replayed, ids, "anthropic");
        expect(result).toEqual({ replayed: 4, missingIds: [] });
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(detected));
        // Replaying again on the same array changes nothing and counts nothing.
        expect(replaySentinelByMessageIds(replayed, ids, "anthropic")).toEqual({
            replayed: 0,
            missingIds: [],
        });
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(detected));
    });

    it("serves identical bytes on every ordinary pass after the rebuilding pass", () => {
        const first = session();
        const ids = new Set(detect(first, "anthropic"));
        const served = [JSON.stringify(first)];
        for (let pass = 0; pass < 4; pass += 1) {
            // Each pass starts from the host's fresh projection, like the real hook.
            const fresh = session();
            replaySentinelByMessageIds(fresh, ids, "anthropic");
            // Detection finds nothing new: replay already neutralized every row.
            expect(detect(fresh, "anthropic")).toEqual([]);
            served.push(JSON.stringify(fresh));
        }
        expect(new Set(served).size).toBe(1);
    });

    it("leaves OpenCode 1 (user and assistant rows only) byte-identical", () => {
        // OpenCode 1 never has a system row, so its Anthropic output must stay the
        // empty sentinel that its own adapter drops before the wire.
        const oc1 = () => session().filter((entry) => entry.info.role !== "system");
        const messages = oc1();
        const ids = new Set(detect(messages, "anthropic"));
        expect(JSON.stringify(messages)).toBe(
            JSON.stringify([
                {
                    info: { id: "u1", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "§1§ start" }],
                },
                {
                    info: { id: "a-marker", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "" }],
                },
                {
                    info: { id: "a-reminder", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "" }],
                },
                {
                    info: { id: "u2", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "§4§ next" }],
                },
            ]),
        );
        const replayed = oc1();
        replaySentinelByMessageIds(replayed, ids, "anthropic");
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(messages));
    });

    it("still removes a non-Anthropic hidden-seam row, and keeps an Anthropic one emptied", () => {
        const ids = new Set(["s-marker", "a-marker"]);
        const openai = session();
        replaySentinelByMessageIds(openai, ids, "openai", ids);
        expect(openai.map((entry) => entry.info.id)).toEqual([
            "u1",
            "s-reminder",
            "a-reminder",
            "u2",
        ]);
        const anthropic = session();
        replaySentinelByMessageIds(anthropic, ids, "anthropic", ids);
        expect(byId(anthropic)).toMatchObject({
            "s-marker": [],
            "a-marker": [{ type: "text", text: "" }],
        });
    });
});
