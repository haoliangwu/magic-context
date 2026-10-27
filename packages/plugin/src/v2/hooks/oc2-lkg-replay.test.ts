import { expect, spyOn, test } from "bun:test";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import { scaleTest } from "../../shared/slow-test";
import {
    type HostVersion,
    installBusyAdmission,
    installTransientFailure,
    lkgEvents,
    type Oc2ContextFixture,
    oc2ContextFixture,
    prose,
    replayDifference,
} from "./__tests__/oc2-context.fixture";

/*
 * OpenCode 2 in TypeScript mode, busy database: a turn replays the last good
 * request (the saved copy) when its input is what that request was built
 * from, and refuses otherwise. The replay must serve exactly the bytes the
 * saved request served, followed by the host's newer messages.
 *
 * Four separate faults kept every such turn from replaying:
 * 1. the fit check looked up the saved system by the system after Magic
 *    Context added its guidance, so a pass failing inside the transform never
 *    matched;
 * 2. the replay before writer admission compared the host's draft before the
 *    rows after a host checkpoint were restored;
 * 3. that replay also left out the stored message times the transform input
 *    carries, so every message digest differed;
 * 4. with temporal awareness off the transform input carried no times at all,
 *    so no copy was ever saved once an assistant message existed.
 */

type Pass = Awaited<ReturnType<Oc2ContextFixture["pass"]>>;
type Attempt = Awaited<ReturnType<Oc2ContextFixture["attempt"]>>;
type Busy = "admission" | "admission-exhausted" | "transform";

const AREA = "oc2-replay";

function bytes(value: unknown): string {
    return JSON.stringify(value);
}

function slotKey(session: string): string | undefined {
    const slot = getSlot(session);
    return slot
        ? bytes([slot.capturedAt, slot.captureSequence, slot.lastInputMessageId, slot.jsonPrefix])
        : undefined;
}

/** Run `body` with busy-database controls and a known context limit installed. */
async function withBusyControls<T>(body: (busy: (kind: Busy) => void) => Promise<T>): Promise<T> {
    const failure = installTransientFailure();
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        return await body((kind) => {
            if (kind === "transform") failure.state.failNext = true;
            else if (kind === "admission") admission.state.busyNext = true;
            else admission.state.exhaustNext = true;
        });
    } finally {
        admission.restore();
        failure.restore();
        limit.mockRestore();
    }
}

/**
 * Let deferred work queued by a pass run, as it does in the time between two
 * requests on a real host (saving the copy to disk runs in setImmediate).
 */
const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const served = (attempt: Attempt) => attempt.logs.some((line) => /\blkg_replay_served$/.test(line));

/**
 * A session with a saved request and then a new user turn: `saved` is the last
 * good pass. With `checkpoint` the host folded before the saved pass.
 */
async function prepare(
    seed: number,
    options: {
        temporal?: boolean;
        checkpoint?: boolean;
        host?: HostVersion;
        instructions?: boolean;
    },
) {
    const f = await oc2ContextFixture(seed, {
        area: AREA,
        temporal: options.temporal ?? true,
        host: options.host ?? "2.0.22",
        instructions: options.instructions ?? false,
    });
    f.compartment(4);
    await f.pass();
    f.respond();
    if (options.checkpoint) {
        await f.pass();
        await f.fold();
        f.user(`${seed} after the checkpoint: ${prose}`, 120000);
        await f.pass();
        f.respond();
    }
    f.user(`${seed} the saved turn: ${prose}`, 120000);
    const saved = await f.pass();
    f.respond();
    f.user(`${seed} the busy turn: ${prose}`, 120000);
    const anchor = getSlot(f.session)?.lastInputMessageId;
    return { f, saved, anchor };
}

async function expectReplay(
    seed: number,
    options: Parameters<typeof prepare>[1],
    busy: Busy,
): Promise<void> {
    await withBusyControls(async (arm) => {
        const { f, saved, anchor } = await prepare(seed, options);
        try {
            expect(anchor).toBeDefined();
            arm(busy);
            const replay = await f.attempt();
            const events = lkgEvents(replay.logs);
            console.log(
                `OC2_REPLAY seed=${seed} busy=${busy} ${bytes(options)} lkg=${events} error=${replay.error ? String(replay.error).slice(0, 60) : "none"}`,
            );
            expect(replay.error).toBeUndefined();
            expect(events).toContain("lkg_replay_served");
            expect(replayDifference(replay, saved, anchor!)).toBeNull();
            // A replay before writer admission never runs the transform.
            if (busy === "admission")
                expect(replay.logs.join("\n")).not.toMatch(/transform scheduler:/);
        } finally {
            await f.cleanup();
        }
    });
}

async function expectRefusal(
    seed: number,
    options: Parameters<typeof prepare>[1],
    change: (f: Oc2ContextFixture) => Promise<void> | void,
): Promise<string> {
    return withBusyControls(async (arm) => {
        const { f } = await prepare(seed, options);
        try {
            await change(f);
            arm("admission-exhausted");
            const refused = await f.attempt();
            const events = lkgEvents(refused.logs);
            console.log(`OC2_REFUSE seed=${seed} ${bytes(options)} lkg=${events}`);
            expect(served(refused)).toBe(false);
            expect(String(refused.error)).toContain("database is busy");
            return events;
        } finally {
            await f.cleanup();
        }
    });
}

// Fault 1: inside the transform, draft.system already carries Magic Context's
// guidance; the saved system is looked up by the system the host sent.
test("OC2 replay: a pass that fails inside the transform serves the saved request", async () => {
    await expectReplay(7601, {}, "transform");
}, 60000);

// Fault 2: after a host checkpoint the transform input starts with the rows
// restored from the store, so the replay before writer admission must compare
// that input, not the host draft that still holds the checkpoint.
for (const host of ["2.0.22", "2.1.0"] as const)
    test(`OC2 replay: writer admission after a host checkpoint serves the saved request (${host})`, async () => {
        await expectReplay(7602, { checkpoint: true, host }, "admission");
    }, 60000);

// Fault 3: the transform input carries the stored message times; the replay
// before writer admission must carry them too, or every digest differs.
test("OC2 replay: writer admission compares the stored message times", async () => {
    await expectReplay(7603, { temporal: true }, "admission");
}, 60000);

// Fault 4: with temporal awareness off a saved copy needs the stored times to
// find its anchor once an assistant message exists.
test("OC2 replay: with temporal awareness off a copy is saved and replays", async () => {
    await expectReplay(7604, { temporal: false }, "admission");
}, 60000);

// The same turns where the database stays busy until writer admission gives up.
for (const [seed, options] of [
    [7605, { checkpoint: true, temporal: false, host: "2.0.22" }],
    [7606, { checkpoint: true, temporal: true, host: "2.1.0" }],
    [7607, { temporal: false }],
] as const)
    test(`OC2 replay: a writer wait that runs out serves the saved request ${bytes(options)}`, async () => {
        await expectReplay(seed, options, "admission-exhausted");
    }, 60000);

test("OC2 replay refuses: the host's system prompt changed", async () => {
    await expectRefusal(7611, { checkpoint: true }, (f) =>
        f.setSystem("Review a different project."),
    );
}, 60000);

test("OC2 replay refuses: a different model", async () => {
    expect(
        await expectRefusal(7612, { checkpoint: true }, (f) => f.setModel("gpt-4.1-mini")),
    ).toContain("lkg_model_mismatch");
}, 60000);

test("OC2 replay refuses: the host folded after the saved request", async () => {
    await expectRefusal(7613, {}, async (f) => {
        await f.pass();
        f.respond();
        await f.fold();
        f.user(`7613 after the new checkpoint: ${prose}`, 120000);
    });
}, 60000);

test("OC2 replay refuses: the host re-rendered its checkpoint message", async () => {
    await expectRefusal(7614, { checkpoint: true }, (f) => {
        const part = f.checkpoint!.content[0]!;
        part.text = `${String(part.text)}\n(re-rendered)`;
    });
}, 60000);

test("OC2 replay refuses: a saved message was edited", async () => {
    expect(
        await expectRefusal(7615, { checkpoint: true }, (f) => {
            const ids = getSlot(f.session)!.inputIdSeq;
            f.edit(ids[ids.length - 2]!, `7615 edited: ${prose}`);
        }),
    ).toContain("lkg_content_mismatch");
}, 60000);

test("OC2 replay refuses: a message was inserted into the saved history", async () => {
    await expectRefusal(7616, {}, (f) => {
        f.insertUser(f.rows.length - 4, `7616 inserted: ${prose}`);
    });
}, 60000);

test("OC2 replay refuses: a restart lost the system served with the saved request", async () => {
    await expectRefusal(7617, { checkpoint: true }, (f) => f.restart());
}, 60000);

/**
 * What a saved request's replay depends on besides the messages: a change to
 * any of these since the request was saved means the turn's input is no
 * longer what the request was built from.
 */
type Envelope = {
    system: number;
    model: number;
    folds: number;
    restarts: number;
    edits: number;
    rerenders: number;
    /**
     * After a host fold, the history boundary the rows are restored from:
     * when an executing pass moves it, the restored input changes.
     */
    boundary: string | null;
};

/**
 * Randomized busy-database differential over the real OpenCode 2 hook. Turns,
 * host checkpoints, compartments, restarts, system and model changes, edited
 * and re-rendered history interleave with busy turns of three kinds (a busy
 * first writer attempt, a writer wait that runs out, a failure inside the
 * transform). Each busy turn either serves a replay, which must hold exactly
 * the bytes of the saved request it came from, or refuses. A turn whose input
 * still matches the saved request must replay; any other turn must not.
 */
async function runBusyDifferential(host: HostVersion, seeds: number[], steps: number) {
    const stats = {
        passes: 0,
        busy: 0,
        served: 0,
        servedAfterCheckpoint: 0,
        servedTemporalOff: 0,
        refusedChanged: 0,
        refusedNoCopy: 0,
        folds: 0,
        restarts: 0,
        failures: [] as string[],
    };
    await withBusyControls(async (arm) => {
        for (const seed of seeds) {
            let random = seed;
            const next = (bound: number) => {
                random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                return random % bound;
            };
            const temporal = seed % 2 === 0;
            const instructions = seed % 5 === 0;
            const f = await oc2ContextFixture(seed, {
                area: AREA,
                host,
                temporal,
                instructions,
                cacheTtl: "1h",
            });
            const envelope: Envelope = {
                system: 0,
                model: 0,
                folds: 0,
                restarts: 0,
                edits: 0,
                rerenders: 0,
                boundary: null,
            };
            const restoreBoundary = () =>
                f.checkpoint
                    ? ((
                          f.db
                              .prepare(
                                  "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                              )
                              .get(f.session) as { id: string | null } | null
                      )?.id ?? null)
                    : null;
            // The pass that saved each copy, with the envelope it was served in.
            const savedBy = new Map<string, { pass: Pass; envelope: Envelope }>();
            // What happened lately, for failure reports.
            const history: string[] = [];
            let lastEdit: { id: string; text: string } | undefined;
            const ordinary = async () => {
                envelope.boundary = restoreBoundary();
                const pass = await f.pass();
                await settle();
                stats.passes++;
                const key = slotKey(f.session);
                history.push(`pass:${lkgEvents(pass.logs)}`);
                if (key && !savedBy.has(key)) savedBy.set(key, { pass, envelope: { ...envelope } });
                return pass;
            };
            const busyTurn = async (kind: Busy, where: string) => {
                stats.busy++;
                envelope.boundary = restoreBoundary();
                const key = slotKey(f.session);
                const anchor = getSlot(f.session)?.lastInputMessageId;
                const saved = key ? savedBy.get(key) : undefined;
                const matches = saved !== undefined && bytes(saved.envelope) === bytes(envelope);
                arm(kind);
                const attempt = await f.attempt();
                await settle();
                stats.passes++;
                const label = `${host} seed ${seed} ${where} busy=${kind} lkg=${lkgEvents(attempt.logs)} saved=${saved ? bytes(saved.envelope) : "none"} now=${bytes(envelope)} recent=${history.slice(-14).join(";")}`;
                history.push(`busy:${kind}:${served(attempt) ? "served" : "declined"}`);
                if (served(attempt)) {
                    stats.served++;
                    if (f.checkpoint) stats.servedAfterCheckpoint++;
                    if (!temporal) stats.servedTemporalOff++;
                    if (!matches || !saved || !anchor) {
                        const edited = lastEdit
                            ? attempt.draft.messages.find((message) => message.id === lastEdit?.id)
                            : undefined;
                        stats.failures.push(
                            `${label}: served a replay for a changed input lastEdit=${bytes(lastEdit)} inInput=${lastEdit ? attempt.inputIds.includes(lastEdit.id) : "-"} servedText=${bytes(edited?.content).slice(0, 120)} window=${bytes(attempt.inputIds.slice(0, 4))}`,
                        );
                        return;
                    }
                    if (attempt.error) stats.failures.push(`${label}: replay also refused`);
                    const difference = replayDifference(attempt, saved.pass, anchor);
                    if (difference) stats.failures.push(`${label}: ${difference}`);
                    return;
                }
                if (matches) {
                    const why = attempt.logs.find((line) =>
                        line.includes("lkg_replay_unavailable"),
                    );
                    stats.failures.push(
                        `${label}: matching input did not replay${why ? ` (${why.slice(0, 300)})` : ""}`,
                    );
                    return;
                }
                if (saved) stats.refusedChanged++;
                else stats.refusedNoCopy++;
                // A busy first attempt that declines runs the pass as usual.
                if (kind === "admission" && !attempt.error) {
                    const key = slotKey(f.session);
                    if (key && !savedBy.has(key))
                        savedBy.set(key, {
                            pass: attempt as Pass,
                            envelope: { ...envelope },
                        });
                } else if (!attempt.error) {
                    stats.failures.push(`${label}: neither replayed nor refused`);
                }
            };
            const busyKinds: Busy[] = ["admission", "admission-exhausted", "transform"];
            try {
                f.compartment(4);
                await ordinary();
                for (let step = 0; step < steps; step++) {
                    const action = next(12);
                    if (action === 0 && envelope.folds < 2 && f.rows.length > 20) {
                        await f.fold(3 + next(3));
                        envelope.folds++;
                        history.push("fold");
                        stats.folds++;
                    } else if (action <= 2) {
                        const limit = f.rows.length - 6;
                        let end = Math.min(limit, f.coveredThrough + 3 + next(6));
                        while (end > f.coveredThrough && f.rows[end]?.type === "system") end--;
                        if (end > f.coveredThrough + 1) f.compartment(end);
                    } else if (action === 3) {
                        await f.restart();
                        envelope.restarts++;
                        history.push("restart");
                        stats.restarts++;
                    } else if (action === 4) {
                        f.setSystem(`Review the isolated project, revision ${step}.`);
                        envelope.system++;
                        history.push("system");
                    } else if (action === 5 && step % 3 === 0) {
                        f.setModel(envelope.model % 2 === 0 ? "gpt-4.1-mini" : "gpt-4.1");
                        envelope.model++;
                        history.push("model");
                    } else if (action === 6) {
                        const ids = getSlot(f.session)?.inputIdSeq ?? [];
                        const id = ids[next(Math.max(1, ids.length))];
                        if (id && f.rows.some((row) => row.id === id)) {
                            lastEdit = { id, text: `${seed}/${step} edited: ${prose}` };
                            f.edit(id, lastEdit.text);
                            envelope.edits++;
                            history.push("edit");
                        }
                    } else if (action === 7 && f.checkpoint) {
                        const part = f.checkpoint.content[0]!;
                        part.text = `${String(part.text)}\n(re-rendered ${step})`;
                        envelope.rerenders++;
                        history.push("rerender");
                    }
                    if (next(4) === 0) f.idle(2);
                    f.user(
                        `${seed}/${step}: ${prose.repeat(1 + next(3))}`,
                        120000 + next(4) * 900000,
                    );
                    if (next(3) === 0) await busyTurn(busyKinds[next(3)]!, `step ${step}`);
                    // The host sends the turn again after a refusal; an ordinary pass.
                    await ordinary();
                    f.respond(1 + next(2));
                    if (next(3) === 0)
                        await busyTurn(busyKinds[next(3)]!, `step ${step} follow-up`);
                    await ordinary();
                    f.respond();
                }
            } finally {
                await f.cleanup();
            }
        }
    });
    return stats;
}

for (const host of ["2.0.22", "2.1.0"] as const)
    scaleTest(
        `OC2 replay differential: busy turns serve only matching saved requests, byte for byte (${host})`,
        async (slow) => {
            const stats = await runBusyDifferential(
                host,
                slow ? [7621, 7622, 7623, 7624, 7625, 7626] : [7621, 7622, 7625],
                26,
            );
            const { failures, ...counts } = stats;
            console.log(
                `OC2_REPLAY_DIFFERENTIAL ${host} ${bytes(counts)} failures=${failures.length}`,
            );
            for (const failure of failures) console.log(`OC2_REPLAY_FAILURE ${failure}`);
            expect(stats.failures).toEqual([]);
            expect(stats.passes).toBeGreaterThanOrEqual(slow ? 300 : 150);
            expect(stats.served).toBeGreaterThan(0);
            expect(stats.servedAfterCheckpoint).toBeGreaterThan(0);
            expect(stats.servedTemporalOff).toBeGreaterThan(0);
            expect(stats.refusedChanged).toBeGreaterThan(0);
            expect(stats.folds).toBeGreaterThan(0);
            expect(stats.restarts).toBeGreaterThan(0);
        },
        900000,
    );
