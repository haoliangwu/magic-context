import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import {
    childCreateInput,
    errorText,
    type HiddenChildHost,
    type HiddenChildLifecycle,
    type HiddenChildModel,
    type HiddenChildRole,
    keptUnderRetention,
    type PersistedHiddenChild,
    roleTitle,
} from "./hidden-child-record";
import type { HiddenChildHook } from "./hooks/hidden-child";

/**
 * The hidden-child lifecycle for OpenCode 2 hosts whose plugin session API has `session.remove`.
 * Every run gets a fresh child created under the user's session, and the child is removed when
 * the run ends, whether it succeeded or failed. Nothing is recorded in context.db: a child whose
 * removal fails still goes when its parent session is deleted, because the host deletes a
 * session's children with it.
 */

type RemoveSession = NonNullable<HiddenChildHost["removeSession"]>;

/**
 * The feature gate for this lifecycle: the host's own `session.remove`, bound to its session API,
 * or undefined on hosts that do not expose one to plugins. Hosts are told apart by what they
 * offer, never by version: development builds report versions such as `0.0.0-dev-20358`.
 */
export function nativeSessionRemove(session: object): RemoveSession | undefined {
    const remove = (session as { remove?: unknown }).remove;
    if (typeof remove !== "function") return undefined;
    return (input) => Promise.resolve(remove.call(session, { sessionID: input.sessionID }));
}

/** True when the host reports that the session is already gone. */
export function isSessionNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const fields = error as { status?: unknown; name?: unknown; _tag?: unknown; message?: unknown };
    if (fields.status === 404) return true;
    const label = [fields.name, fields._tag, fields.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
    return /not\s*found/i.test(label);
}

// A host that drops the parent of a created session does it for every session, so saying so once
// per process is enough.
let parentDroppedNoted = false;

/** Clears the once-per-process notice, for tests. */
export function __resetParentDroppedNotice(): void {
    parentDroppedNoted = false;
}

export function createNativeHiddenChildren(
    host: HiddenChildHost,
    removeSession: RemoveSession,
    options: {
        hook: HiddenChildHook;
        generation: string;
        keepSubagents: boolean;
        log: (message: string) => void;
        removalTimeoutMs?: number;
    },
): HiddenChildLifecycle {
    // Removals in flight, so a finished run can wait for the removal its own failure started.
    const removing = new Map<string, Promise<void>>();

    const remove = (child: PersistedHiddenChild): Promise<void> => {
        const inFlight = removing.get(child.id);
        if (inFlight) return inFlight;
        const done = (async () => {
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        removeSession({ sessionID: child.id }),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error("session.remove timed out")),
                                options.removalTimeoutMs ?? 5000,
                            );
                        }),
                    ]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            } catch (error) {
                if (isSessionNotFound(error)) return;
                options.log(
                    `[magic-context] hidden child ${child.id} could not be removed; it goes when its parent session is deleted: ${errorText(error)}`,
                );
            }
        })().finally(() => {
            removing.delete(child.id);
        });
        removing.set(child.id, done);
        return done;
    };

    /** Reads the new session back, because a host can accept `parentID` and silently drop it. */
    const confirmParent = async (sessionID: string, parentID: string): Promise<void> => {
        let stored: string | undefined;
        try {
            stored = (await host.get({ sessionID })).parentID;
        } catch (error) {
            options.log(
                `[magic-context] could not read back hidden child ${sessionID} to confirm its parent: ${errorText(error)}`,
            );
            return;
        }
        if (stored === parentID || parentDroppedNoted) return;
        parentDroppedNoted = true;
        options.log(
            `[magic-context] this OpenCode 2 host does not keep the parent of hidden-run sessions (asked for ${parentID}, read back ${stored ?? "none"}); they are created as separate sessions and still removed when each run ends`,
        );
    };

    const create = async (
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
    ): Promise<PersistedHiddenChild> => {
        const parentID = identity.parentSessionId;
        const input = childCreateInput(identity, role, model);
        const { location, ...parented } = input;
        const created = await host.create(
            parentID ? { ...parented, parentID } : { ...parented, location },
        );
        if (!created.id) throw new Error("OpenCode 2 did not return a child session id");
        // Registered before anything else can fail, so a child removed after a failed read-back is
        // still recognised by the hidden-child hook while it lives.
        options.hook.registerChild(created.id);
        if (parentID) await confirmParent(created.id, parentID);
        return {
            id: created.id,
            role,
            generation: options.generation,
            title: roleTitle(role),
            model,
            created_at: Date.now(),
            directory: identity.directory,
        };
    };

    // keep_subagents retains inspectable runs under the user's session.
    const kept = (child: PersistedHiddenChild) => keptUnderRetention(options.keepSubagents, child);

    return {
        open: create,
        create,
        retire(child) {
            if (!kept(child)) void remove(child);
        },
        async finish(child, retired) {
            if (retired) {
                await removing.get(child.id);
                return;
            }
            if (!kept(child)) await remove(child);
        },
        updateModel: (child, model) => ({ ...child, model }),
        markEverSettled: (child) => ({ ...child, ever_settled: true }),
    };
}
