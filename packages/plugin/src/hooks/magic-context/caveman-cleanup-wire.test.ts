/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { getCavemanReplayState } from "../../features/magic-context/storage-caveman-rules";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getActiveTagsBySession,
    updateCavemanDepth,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { type CavemanWordRules, cavemanCompress } from "./caveman";
import { applyCavemanCleanup, replayCavemanCompression } from "./caveman-cleanup";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { type MessageLike, tagMessages } from "./tag-messages";

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

const TEXTS = [
    "I think we should really refactor the database configuration, and the historian was compressed.",
    "Perhaps the cache was invalidated and then the session was reloaded. Ask Mar\u00eda about the d\u00eda para fix.",
    "Basically the context window was exceeded because the compartment was simply too large today.",
    "Actually the transform replayed the bytes and the tests were fixed in the repository yesterday.",
    "Finally the deploy was finished and the release notes were published for the whole team today.",
];
const REASONING = "Working out which cache layer invalidated first.";

/** Five tagged texts; assistant turns carry a reasoning part before their text. */
function buildMessages(sessionId: string): MessageLike[] {
    return TEXTS.map((text, index) => {
        const role = index % 2 === 0 ? "user" : "assistant";
        const parts: unknown[] =
            role === "assistant"
                ? [
                      { type: "reasoning", text: REASONING },
                      { type: "text", text },
                  ]
                : [{ type: "text", text }];
        return { info: { id: `msg-${index + 1}`, role, sessionID: sessionId }, parts };
    });
}

type Pass = {
    messages: MessageLike[];
    targets: ReturnType<typeof tagMessages>["targets"];
    messageTagNumbers: ReturnType<typeof tagMessages>["messageTagNumbers"];
};

/** One transform pass up to the caveman replay that every pass runs. */
function runPass(db: DatabaseType, sessionId: string): Pass {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const messages = buildMessages(sessionId);
    const { targets, messageTagNumbers } = tagMessages(sessionId, messages, tagger, db);
    replayCavemanCompression(sessionId, db, targets, getActiveTagsBySession(db, sessionId));
    return { messages, targets, messageTagNumbers };
}

/** A pass that already rebuilds the cache: replay, then fresh cleanup. */
function runRebuildingPass(
    db: DatabaseType,
    sessionId: string,
    wordRules: CavemanWordRules = "english",
): Pass {
    const pass = runPass(db, sessionId);
    applyCavemanCleanup(sessionId, db, pass.targets, getActiveTagsBySession(db, sessionId), {
        enabled: true,
        minChars: 20,
        protectedCutoff: null,
        wordRules,
    });
    return pass;
}

const wire = (messages: MessageLike[]): string => JSON.stringify(messages);
/** The message's own text: its last part (a neutralized reasoning part is also a text part). */
const textOf = (message: MessageLike): string =>
    (message.parts[message.parts.length - 1] as { text: string }).text;
const reasoningOf = (message: MessageLike): unknown => message.parts[0];

describe("caveman compression on the wire", () => {
    it("keeps the tag prefix on compressed text, on the compressing pass and on replay", () => {
        const db = openTestDb();
        const sessionId = "ses-caveman-prefix";
        runPass(db, sessionId);

        const rebuilt = runRebuildingPass(db, sessionId);
        const replayed = runPass(db, sessionId);

        // Positions 0, 1, 2 of five eligible tags compress to ultra, full, lite.
        const levels = ["ultra", "full", "lite"] as const;
        levels.forEach((level, index) => {
            const expected = `\u00a7${index + 1}\u00a7 ${cavemanCompress(TEXTS[index], level)}`;
            expect(textOf(rebuilt.messages[index])).toBe(expected);
        });
        // Words next to accented letters survive: the final "a" of "Mar\u00eda" is not an article.
        expect(textOf(rebuilt.messages[1])).toBe(
            "\u00a72\u00a7 cache invalidated and then session reloaded. Ask Mar\u00eda about d\u00eda para fix.",
        );
        expect(wire(replayed.messages)).toBe(wire(rebuilt.messages));
    });

    it("keeps the reasoning of a compressed assistant message", () => {
        const db = openTestDb();
        const sessionId = "ses-caveman-reasoning";
        runPass(db, sessionId);

        const rebuilt = runRebuildingPass(db, sessionId);
        const replayed = runPass(db, sessionId);

        for (const pass of [rebuilt, replayed]) {
            expect(reasoningOf(pass.messages[1])).toEqual({ type: "reasoning", text: REASONING });
        }
        expect(wire(replayed.messages)).toBe(wire(rebuilt.messages));
    });

    it("replays the original rules until a rebuilding pass switches, then serves the switch pass bytes", () => {
        const db = openTestDb();
        const sessionId = "ses-caveman-switch";
        runPass(db, sessionId);
        // An older release compressed tags 1 and 2 and recorded nothing else.
        updateCavemanDepth(db, sessionId, 1, 3);
        updateCavemanDepth(db, sessionId, 2, 2);

        const legacy = runPass(db, sessionId);
        expect(textOf(legacy.messages[0])).toBe(cavemanCompress(TEXTS[0], "ultra", "ascii-v1"));
        expect(textOf(legacy.messages[1])).toBe(cavemanCompress(TEXTS[1], "full", "ascii-v1"));
        expect(textOf(legacy.messages[1])).toContain("Mar\u00edabout");
        // The original rules took the compressed message's reasoning off the wire.
        expect(reasoningOf(legacy.messages[1])).toEqual({ type: "text", text: "" });
        expect(wire(runPass(db, sessionId).messages)).toBe(wire(legacy.messages));
        expect(getCavemanReplayState(db, sessionId).currentRules).toBe(false);

        const switched = runRebuildingPass(db, sessionId);
        expect(getCavemanReplayState(db, sessionId)).toEqual({
            currentRules: true,
            englishWordRules: true,
            legacyReasoningTags: new Set([1, 2]),
        });
        expect(textOf(switched.messages[0])).toBe(
            `\u00a71\u00a7 ${cavemanCompress(TEXTS[0], "ultra")}`,
        );
        expect(textOf(switched.messages[1])).toBe(
            `\u00a72\u00a7 ${cavemanCompress(TEXTS[1], "full")}`,
        );
        // Reasoning that already left stays gone; the newly compressed tag 4
        // is not compressed (position 3 of 5), and tag 3 is a user text.
        expect(reasoningOf(switched.messages[1])).toEqual({ type: "text", text: "" });
        expect(reasoningOf(switched.messages[3])).toEqual({ type: "reasoning", text: REASONING });

        const after = runPass(db, sessionId);
        expect(wire(after.messages)).toBe(wire(switched.messages));
    });

    it("applies a changed language setting only on a rebuilding pass", () => {
        const db = openTestDb();
        const sessionId = "ses-caveman-language";
        runPass(db, sessionId);
        const english = runRebuildingPass(db, sessionId);
        expect(textOf(english.messages[0])).toBe(
            `\u00a71\u00a7 ${cavemanCompress(TEXTS[0], "ultra")}`,
        );

        // The setting changed to Spanish: passes that only replay keep the English bytes.
        const replayed = runPass(db, sessionId);
        expect(wire(replayed.messages)).toBe(wire(english.messages));

        const switched = runRebuildingPass(db, sessionId, "none");
        expect(getCavemanReplayState(db, sessionId).englishWordRules).toBe(false);
        for (let index = 0; index < 3; index += 1) {
            expect(textOf(switched.messages[index])).toBe(
                `\u00a7${index + 1}\u00a7 ${cavemanCompress(TEXTS[index], "lite", undefined, "none")}`,
            );
        }
        expect(textOf(switched.messages[0])).toContain("I think we should really refactor");
        expect(wire(runPass(db, sessionId).messages)).toBe(wire(switched.messages));

        // Back to English, again on a rebuilding pass only.
        expect(wire(runPass(db, sessionId).messages)).toBe(wire(switched.messages));
        const back = runRebuildingPass(db, sessionId, "english");
        expect(wire(back.messages)).toBe(wire(english.messages));
    });

    it("keeps the reasoning when only a system injection is stripped from the text", () => {
        const db = openTestDb();
        const sessionId = "ses-caveman-injection";
        const injected =
            "Deploy finished.\n\n<system-reminder>Remember the todo list.</system-reminder>";
        const build = (): MessageLike[] => [
            {
                info: { id: "u-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "go" }],
            },
            {
                info: { id: "a-1", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "reasoning", text: REASONING },
                    { type: "text", text: injected },
                ],
            },
            {
                info: { id: "u-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "next" }],
            },
        ];
        const serve = () => {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const messages = build();
            const result = tagMessages(sessionId, messages, tagger, db);
            return { messages, ...result };
        };
        serve();

        const stripPass = serve();
        applyHeuristicCleanup(
            sessionId,
            db,
            stripPass.targets,
            stripPass.messageTagNumbers,
            { protectedTagNumbers: new Set(), protectedCutoff: null, routine: true },
            getActiveTagsBySession(db, sessionId),
        );
        const later = serve();

        expect(textOf(stripPass.messages[1])).toBe("\u00a72\u00a7 Deploy finished.");
        expect(reasoningOf(stripPass.messages[1])).toEqual({ type: "reasoning", text: REASONING });
        expect(wire(later.messages)).toBe(wire(stripPass.messages));
    });
});
