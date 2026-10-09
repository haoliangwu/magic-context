/**
 * The checkout claim check: before Magic Context writes anything for a session
 * in this host process, find the agent that owns the session and refuse to
 * work on it while another machine holds that agent's checkout claim.
 *
 * Two fleet modules answer, both over subc:
 *   - ALF (`prefrontal-core`, management surface) maps a host session to its
 *     agent with `agent.for_host_session`. Worker sessions and sessions it does
 *     not know answer `{"agent_id": null}`: there is no claim to check.
 *   - Engram (`engram`, internal service `agent-sync`) answers `claim.read` for
 *     `agent:<id>` with `held_here`, `held_elsewhere` and `epoch`. An agent that
 *     was never claimed reads epoch 0 and `held_elsewhere: false`.
 *
 * Decision rule (documented here because nothing else records it):
 *   - `held_elsewhere: true` refuses the turn with MC-C16 and names the holder.
 *   - Everything else is admitted: a null agent, a claim held here, an
 *     unclaimed agent, and a check that could not finish (no subc connection
 *     file, daemon or module unreachable, a module error such as
 *     `store_error`, a reply this build cannot read, or the latency budget
 *     running out). An incomplete check logs a warning. The fleet has to keep
 *     working without engram, so only a definite answer from it refuses.
 *
 * Cost: one check per session per {@link CHECKOUT_CLAIM_TTL_MS}, deduplicated
 * while in flight, and bounded by {@link CHECKOUT_CLAIM_CHECK_TIMEOUT_MS}. The
 * cache lives in this process, so a host restart checks again. Expiry is
 * measured on the wall clock on purpose: a machine that slept past the TTL
 * (when a move to another machine is most likely) re-checks on its first pass
 * after waking.
 */
import { connectionFileExists, SubcClient } from "@cortexkit/subc-client";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { USER_FACING_FAILURES } from "../../shared/user-facing-codes";

export const ALF_MODULE_ID = "prefrontal-core";
export const ALF_AGENT_FOR_HOST_SESSION_OP = "agent.for_host_session";
export const ENGRAM_MODULE_ID = "engram";
export const ENGRAM_AGENT_SYNC_SERVICE_ID = "agent-sync";
export const ENGRAM_CLAIM_READ_OP = "claim.read";

/** How long an admitted verdict (checked or not) is reused for a session. */
export const CHECKOUT_CLAIM_TTL_MS = 60_000;
/**
 * How long a refusal is reused. Short, so that a turn retried after the agent
 * moves back to this machine goes through without waiting out the full TTL,
 * while the several passes of one refused turn still share one check.
 */
export const CHECKOUT_CLAIM_REFUSAL_RECHECK_MS = 5_000;
/** The whole check (connect, both queries) must finish within this budget. */
export const CHECKOUT_CLAIM_CHECK_TIMEOUT_MS = 1_500;

const CACHE_MAX_SESSIONS = 1_000;

export const CHECKOUT_CLAIM_REFUSAL_CODE = "checkout_claim_held_elsewhere";

/** ALF's harness names for host sessions. OMP runs the Pi plugin and its sessions are Pi's. */
export type CheckoutClaimHarness = "opencode" | "pi";

export type CheckoutClaimOutcome =
    | {
          verdict: "admit";
          reason: "no_agent" | "held_here" | "unclaimed" | "not_held_elsewhere";
          agentId: string | null;
          epoch?: number;
      }
    | {
          verdict: "admit_unchecked";
          reason: "not_configured" | "error" | "timeout" | "invalid_reply";
          stage: "connect" | "agent" | "claim";
          agentId?: string;
          code?: string;
          detail: string;
      }
    | {
          verdict: "refuse";
          agentId: string;
          holder: string | null;
          epoch: number | null;
      };

/** One connected client for a single check. Each query resolves to the module's reply body. */
export interface CheckoutClaimConnection {
    agentForHostSession(
        params: { harness: CheckoutClaimHarness; session: string },
        timeoutMs: number,
    ): Promise<unknown>;
    claimRead(params: { subject: string }, timeoutMs: number): Promise<unknown>;
    close(): void;
}

/** Opens a connection for one check, or returns null when subc is not configured on this machine. */
export type CheckoutClaimConnector = (args: {
    harness: CheckoutClaimHarness;
    sessionId: string;
    projectRoot: string;
    timeoutMs: number;
}) => Promise<CheckoutClaimConnection | null>;

export function renderCheckoutClaimRefusal(holder: string | null, epoch: number | null): string {
    const failure = USER_FACING_FAILURES.checkout_claim_held_elsewhere;
    const where = [
        holder ? `holding machine: ${holder}` : "holding machine: not named by the claim",
        epoch !== null ? `claim epoch ${epoch}` : null,
    ]
        .filter((part): part is string => part !== null)
        .join(", ");
    return `${failure.sentence} (${where}) ${failure.action} (${failure.code})`;
}

/** The turn is refused because another machine holds the session's agent. */
export class CheckoutClaimRefusalError extends Error {
    readonly code = CHECKOUT_CLAIM_REFUSAL_CODE;
    readonly userFacingCode = USER_FACING_FAILURES.checkout_claim_held_elsewhere.code;
    readonly agentId: string;
    readonly holder: string | null;
    readonly epoch: number | null;

    constructor(args: { agentId: string; holder: string | null; epoch: number | null }) {
        super(renderCheckoutClaimRefusal(args.holder, args.epoch));
        this.name = "CheckoutClaimRefusalError";
        this.agentId = args.agentId;
        this.holder = args.holder;
        this.epoch = args.epoch;
    }
}

/** Matches the refusal across bundled copies of this module, which do not share the class. */
export function isCheckoutClaimRefusalError(error: unknown): error is CheckoutClaimRefusalError {
    return (
        error instanceof CheckoutClaimRefusalError ||
        (error instanceof Error &&
            (error as { code?: unknown }).code === CHECKOUT_CLAIM_REFUSAL_CODE)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Both modules wrap their answer as `{"result": ...}`; accept the bare answer too. */
function unwrapResult(value: unknown): unknown {
    if (isRecord(value) && Object.keys(value).length === 1 && "result" in value) {
        return value.result;
    }
    return value;
}

function errorCode(error: unknown): string | undefined {
    const code =
        isRecord(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorDetail(error: unknown): string {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return text.slice(0, 300);
}

type ParsedAgent = { ok: true; agentId: string | null } | { ok: false; detail: string };

export function parseAgentForHostSessionReply(reply: unknown): ParsedAgent {
    const body = unwrapResult(reply);
    if (!isRecord(body) || !("agent_id" in body)) {
        return {
            ok: false,
            detail: `reply has no agent_id: ${JSON.stringify(reply)?.slice(0, 200)}`,
        };
    }
    const agentId = body.agent_id;
    if (agentId === null) return { ok: true, agentId: null };
    if (typeof agentId === "string" && agentId.length > 0) return { ok: true, agentId };
    return { ok: false, detail: `agent_id is neither a non-empty string nor null` };
}

type ParsedClaim =
    | {
          ok: true;
          heldElsewhere: boolean;
          heldHere: boolean;
          epoch: number;
          holder: string | null;
      }
    | { ok: false; detail: string };

export function parseClaimReadReply(reply: unknown): ParsedClaim {
    const view = unwrapResult(reply);
    if (!isRecord(view)) return { ok: false, detail: "claim view is not an object" };
    const epoch = view.epoch;
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
        return { ok: false, detail: "claim view has no valid epoch" };
    }
    if (typeof view.held_here !== "boolean") {
        return { ok: false, detail: "claim view has no held_here" };
    }
    const heldHere = view.held_here;
    // Engram derives held_elsewhere itself. A reply from an engram build that
    // predates the field gets the same derivation: claimed (epoch >= 1, not
    // absent) and not held here. Keying on held_here alone would refuse every
    // agent that was never claimed.
    let heldElsewhere: boolean;
    if (typeof view.held_elsewhere === "boolean") {
        heldElsewhere = view.held_elsewhere;
    } else if (view.held_elsewhere === undefined) {
        heldElsewhere = view.absent !== true && !heldHere && epoch >= 1;
    } else {
        return { ok: false, detail: "claim view has a non-boolean held_elsewhere" };
    }
    const holder = typeof view.holder === "string" && view.holder.length > 0 ? view.holder : null;
    return { ok: true, heldElsewhere, heldHere, epoch, holder };
}

class CheckoutClaimTimeout extends Error {}

/**
 * Run one check end to end within `timeoutMs`. Never throws: every way the
 * check can fail to finish is an `admit_unchecked` outcome.
 */
export async function readCheckoutClaim(args: {
    connector: CheckoutClaimConnector;
    harness: CheckoutClaimHarness;
    sessionId: string;
    projectRoot: string;
    timeoutMs: number;
    now?: () => number;
}): Promise<CheckoutClaimOutcome> {
    const now = args.now ?? Date.now;
    const deadline = now() + args.timeoutMs;
    const remaining = () => Math.max(1, deadline - now());
    let connection: CheckoutClaimConnection | null = null;
    let stage: "connect" | "agent" | "claim" = "connect";
    let agentId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckoutClaimTimeout()), args.timeoutMs);
    });
    const run = async (): Promise<CheckoutClaimOutcome> => {
        connection = await args.connector({
            harness: args.harness,
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            timeoutMs: remaining(),
        });
        if (!connection) {
            return {
                verdict: "admit_unchecked",
                reason: "not_configured",
                stage: "connect",
                detail: "no subc connection file",
            };
        }
        stage = "agent";
        const agentReply = await connection.agentForHostSession(
            { harness: args.harness, session: args.sessionId },
            remaining(),
        );
        const agent = parseAgentForHostSessionReply(agentReply);
        if (!agent.ok) {
            return {
                verdict: "admit_unchecked",
                reason: "invalid_reply",
                stage,
                detail: agent.detail,
            };
        }
        if (agent.agentId === null) return { verdict: "admit", reason: "no_agent", agentId: null };
        agentId = agent.agentId;
        stage = "claim";
        const claimReply = await connection.claimRead(
            { subject: `agent:${agent.agentId}` },
            remaining(),
        );
        const claim = parseClaimReadReply(claimReply);
        if (!claim.ok) {
            return {
                verdict: "admit_unchecked",
                reason: "invalid_reply",
                stage,
                agentId,
                detail: claim.detail,
            };
        }
        if (claim.heldElsewhere) {
            return {
                verdict: "refuse",
                agentId: agent.agentId,
                holder: claim.holder,
                epoch: claim.epoch,
            };
        }
        return {
            verdict: "admit",
            reason: claim.heldHere
                ? "held_here"
                : claim.epoch === 0
                  ? "unclaimed"
                  : "not_held_elsewhere",
            agentId: agent.agentId,
            epoch: claim.epoch,
        };
    };
    try {
        return await Promise.race([run(), timeout]);
    } catch (error) {
        if (error instanceof CheckoutClaimTimeout) {
            return {
                verdict: "admit_unchecked",
                reason: "timeout",
                stage,
                ...(agentId ? { agentId } : {}),
                detail: `check did not finish within ${args.timeoutMs} ms`,
            };
        }
        const code = errorCode(error);
        return {
            verdict: "admit_unchecked",
            reason: "error",
            stage,
            ...(agentId ? { agentId } : {}),
            ...(code ? { code } : {}),
            detail: errorDetail(error),
        };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        try {
            (connection as CheckoutClaimConnection | null)?.close();
        } catch {
            // Closing a half-open client is best-effort.
        }
    }
}

/**
 * The production connector: a fresh subc client per check, authenticated as a
 * direct caller (both queries admit direct callers), closed when the check ends.
 */
export function subcCheckoutClaimConnector(connectionFile: () => string): CheckoutClaimConnector {
    return async ({ harness, sessionId, projectRoot, timeoutMs }) => {
        const file = connectionFile();
        if (!(await connectionFileExists(file))) return null;
        const client = await SubcClient.connect({
            connectionFile: file,
            handshakeTimeoutMs: timeoutMs,
            // A route.open refused because a module is reloading would otherwise
            // be retried for up to the daemon's drain ceiling; the check's own
            // budget is the only deadline that matters here.
            routeOpenRetryDeadlineMs: timeoutMs,
        });
        const identity = { project_root: projectRoot, harness, session: sessionId };
        return {
            agentForHostSession: (params, requestTimeoutMs) =>
                client.call(ALF_MODULE_ID, ALF_AGENT_FOR_HOST_SESSION_OP, params, {
                    identity,
                    targetKind: "management_surface",
                    consumerIdentity: null,
                    timeoutMs: requestTimeoutMs,
                }),
            claimRead: async (params, requestTimeoutMs) => {
                const route = await client.routeOpen(
                    {
                        kind: "internal_service",
                        module_id: ENGRAM_MODULE_ID,
                        service_id: ENGRAM_AGENT_SYNC_SERVICE_ID,
                    },
                    identity,
                    { consumerIdentity: null },
                );
                return client.request(
                    route,
                    { method: ENGRAM_CLAIM_READ_OP, params },
                    { timeoutMs: requestTimeoutMs },
                );
            },
            close: () => client.close(),
        };
    };
}

export interface CheckoutClaimGateOptions {
    harness: CheckoutClaimHarness;
    connector: CheckoutClaimConnector;
    /** Runs one check; tests substitute it to drive the cache with fixed outcomes. */
    read?: typeof readCheckoutClaim;
    ttlMs?: number;
    refusalRecheckMs?: number;
    timeoutMs?: number;
    now?: () => number;
}

interface CachedOutcome {
    outcome: CheckoutClaimOutcome;
    expiresAt: number;
}

/**
 * Per-process gate over {@link readCheckoutClaim}: caches each session's
 * verdict, shares one in-flight check per session, and turns a refusal into
 * {@link CheckoutClaimRefusalError}.
 */
export class CheckoutClaimGate {
    readonly harness: CheckoutClaimHarness;
    private readonly connector: CheckoutClaimConnector;
    private readonly read: typeof readCheckoutClaim;
    private readonly ttlMs: number;
    private readonly refusalRecheckMs: number;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly cache = new BoundedSessionMap<CachedOutcome>(CACHE_MAX_SESSIONS);
    private readonly inFlight = new Map<string, Promise<CheckoutClaimOutcome>>();

    constructor(options: CheckoutClaimGateOptions) {
        this.harness = options.harness;
        this.connector = options.connector;
        this.read = options.read ?? readCheckoutClaim;
        this.ttlMs = options.ttlMs ?? CHECKOUT_CLAIM_TTL_MS;
        this.refusalRecheckMs = options.refusalRecheckMs ?? CHECKOUT_CLAIM_REFUSAL_RECHECK_MS;
        this.timeoutMs = options.timeoutMs ?? CHECKOUT_CLAIM_CHECK_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    /** The session's verdict, from the cache while it is fresh. */
    async check(sessionId: string, projectRoot: string): Promise<CheckoutClaimOutcome> {
        const cached = this.cache.get(sessionId);
        if (cached && this.now() < cached.expiresAt) return cached.outcome;
        const pending = this.inFlight.get(sessionId);
        if (pending) return pending;
        const run = this.runCheck(sessionId, projectRoot);
        this.inFlight.set(sessionId, run);
        try {
            return await run;
        } finally {
            if (this.inFlight.get(sessionId) === run) this.inFlight.delete(sessionId);
        }
    }

    /** The refusal to raise for this session, or null when it is admitted. */
    async refusal(
        sessionId: string,
        projectRoot: string,
    ): Promise<CheckoutClaimRefusalError | null> {
        const outcome = await this.check(sessionId, projectRoot);
        if (outcome.verdict !== "refuse") return null;
        return new CheckoutClaimRefusalError({
            agentId: outcome.agentId,
            holder: outcome.holder,
            epoch: outcome.epoch,
        });
    }

    /** Throws {@link CheckoutClaimRefusalError} when another machine holds the session's agent. */
    async enforce(sessionId: string, projectRoot: string): Promise<void> {
        const refusal = await this.refusal(sessionId, projectRoot);
        if (refusal) throw refusal;
    }

    /** Drop a session's cached verdict so its next pass checks again. */
    forget(sessionId: string): void {
        this.cache.delete(sessionId);
    }

    private async runCheck(sessionId: string, projectRoot: string): Promise<CheckoutClaimOutcome> {
        const outcome = await this.read({
            connector: this.connector,
            harness: this.harness,
            sessionId,
            projectRoot,
            timeoutMs: this.timeoutMs,
            now: this.now,
        });
        const lifetime = outcome.verdict === "refuse" ? this.refusalRecheckMs : this.ttlMs;
        this.cache.set(sessionId, { outcome, expiresAt: this.now() + lifetime });
        logOutcome(sessionId, outcome);
        return outcome;
    }
}

function logOutcome(sessionId: string, outcome: CheckoutClaimOutcome): void {
    if (outcome.verdict === "refuse") {
        sessionLog(
            sessionId,
            `checkout claim: REFUSED agent=${outcome.agentId} is held elsewhere holder=${outcome.holder ?? "unnamed"} epoch=${outcome.epoch ?? "unknown"}`,
        );
    } else if (outcome.verdict === "admit_unchecked") {
        sessionLog(
            sessionId,
            `checkout claim: WARNING check incomplete, admitting reason=${outcome.reason} stage=${outcome.stage}${outcome.agentId ? ` agent=${outcome.agentId}` : ""}${outcome.code ? ` code=${outcome.code}` : ""} detail=${JSON.stringify(outcome.detail)}`,
        );
    } else {
        sessionLog(
            sessionId,
            `checkout claim: admitted reason=${outcome.reason}${outcome.agentId ? ` agent=${outcome.agentId}` : ""}${outcome.epoch !== undefined ? ` epoch=${outcome.epoch}` : ""}`,
        );
    }
}

/** The gate production hosts use: subc's connection file, ALF and engram over it. */
export function createSubcCheckoutClaimGate(
    harness: CheckoutClaimHarness,
    connectionFile: () => string,
): CheckoutClaimGate {
    return new CheckoutClaimGate({
        harness,
        connector: subcCheckoutClaimConnector(connectionFile),
    });
}

/**
 * The session an OpenCode 1 bus event belongs to, or undefined for events that
 * name none. Session lifecycle events carry it as `info.id`; message events as
 * `info.sessionID`; part events as `part.sessionID`; the rest as `sessionID`.
 */
export function openCodeEventSessionId(event: {
    type?: unknown;
    properties?: unknown;
}): string | undefined {
    const properties = isRecord(event.properties) ? event.properties : undefined;
    if (!properties) return undefined;
    const pick = (value: unknown) =>
        typeof value === "string" && value.length > 0 ? value : undefined;
    const info = isRecord(properties.info) ? properties.info : undefined;
    const part = isRecord(properties.part) ? properties.part : undefined;
    const isSessionEvent = typeof event.type === "string" && event.type.startsWith("session.");
    return (
        pick(properties.sessionID) ??
        pick(info?.sessionID) ??
        pick(part?.sessionID) ??
        (isSessionEvent ? pick(info?.id) : undefined)
    );
}
