import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import { log } from "../../../shared/logger";
import { sanitizeDiagnosticText } from "../../../shared/redaction";
import { CHUNK_WINDOW_SAFETY_RATIO } from "../compartment-chunk-embedding";
import type { EmbeddingFailure, EmbeddingFailureClass } from "./embedding-failure";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { embeddingModelsMatch, resolveEmbeddingTextPrefixes } from "./embedding-model-match";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import { blockedEmbeddingEndpointReason } from "./embedding-ssrf";

interface OpenAICompatibleEmbeddingProviderOptions {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    /** Default/passage `input_type` body field (e.g. NVIDIA NIM 'passage'). */
    inputType?: string;
    /** Optional query `input_type` for search embeddings; falls back to inputType when unset. */
    queryInputType?: string;
    /** Query text prefix override. `false` disables the model-family default. */
    queryInstruction?: string | false;
    /** Passage text prefix override. Defaults to the model-family recipe. */
    documentPrefix?: string;
    /** Optional `truncate` body field (e.g. NVIDIA NIM 'NONE'/'START'/'END'). */
    truncate?: string;
    /** Maximum safe input tokens for chunk embeddings. */
    maxInputTokens?: number;
}

interface EmbeddingResponseBody {
    data?: Array<{
        embedding?: number[];
        /** Position of the input this vector belongs to. */
        index?: unknown;
    }>;
    /** The model the endpoint actually served. OpenAI and most compatible
     *  servers echo back the requested model; LMStudio/Ollama return the model
     *  they ACTUALLY ran, which can differ from the request when the requested
     *  model isn't loaded and the server substitutes a loaded one. */
    model?: string;
}

/**
 * Map each response item to the input it embeds. The OpenAI contract tags
 * every item with `index`, and a proxy may return items out of order, so the
 * tag wins over array position; storing a vector against the wrong text would
 * silently corrupt the index. Items without any `index` keep array order.
 * Returns null when the tags are partial, duplicated or out of range.
 */
function responseSlots(items: readonly { index?: unknown }[], inputCount: number): number[] | null {
    if (items.every((item) => item?.index === undefined)) {
        return items.map((_, position) => position);
    }
    const slots: number[] = [];
    const seen = new Set<number>();
    for (const item of items) {
        const index = item?.index;
        if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= inputCount ||
            seen.has(index)
        ) {
            return null;
        }
        seen.add(index);
        slots.push(index);
    }
    return slots;
}

function capEmbeddingInput(
    input: string,
    maxInputTokens: number,
    purpose: EmbeddingPurpose | undefined,
): string {
    // Queries are raw user text, so they get the chunker's safety margin. Documents
    // were already chunked to that margin without counting the instruction prefix,
    // so they are only cut at the full limit: a full-size chunk plus a short prefix
    // must reach the model whole.
    const ratio = purpose === "query" ? CHUNK_WINDOW_SAFETY_RATIO : 1;
    const budget = Math.max(1, Math.floor(maxInputTokens * ratio));
    if (estimateTokens(input) <= budget) return input;
    // Search tasks are usually stated first, so preserve the useful beginning.
    let low = 0;
    let high = input.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(input.slice(0, mid)) <= budget) low = mid;
        else high = mid - 1;
    }
    // UTF-16 slicing can otherwise leave an unmatched high surrogate.
    if (low > 0 && low < input.length) {
        const last = input.charCodeAt(low - 1);
        const next = input.charCodeAt(low);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) low -= 1;
    }
    return input.slice(0, low);
}

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

export { embeddingModelsMatch } from "./embedding-model-match";

/**
 * Circuit breaker constants. Shared across all callers of this provider so a
 * hung/saturated endpoint (e.g., LMStudio overloaded by parallel council
 * subagents) cannot keep dragging every plugin operation through its timeout.
 *
 * State machine (canonical three-state):
 *   - CLOSED:     issue requests; track failures in a rolling window. After
 *                 FAILURE_THRESHOLD failures within FAILURE_WINDOW_MS → OPEN.
 *   - OPEN:       short-circuit every call and return nulls immediately, no
 *                 HTTP. After OPEN_DURATION_MS elapses → HALF_OPEN.
 *   - HALF_OPEN:  let exactly ONE call through as a probe. Any other caller
 *                 during the probe short-circuits (no stampede on recovery).
 *                 Probe success → CLOSED; probe failure → OPEN immediately
 *                 for another OPEN_DURATION_MS.
 *
 * Design notes:
 *   - The half-open probe uses `halfOpenProbeInFlight` to prevent concurrent
 *     callers from all sending real requests the moment the open timer elapses
 *     (stampede). Only the first caller becomes the probe; the rest short-
 *     circuit as if the circuit were still OPEN.
 *   - A single failure on the probe re-opens the circuit. This matches the
 *     canonical pattern: if the probe fails, the endpoint is still sick.
 *   - On success, we fully close and reset failure counters.
 */
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

type CircuitState = "closed" | "open" | "half_open";

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;

    private readonly endpoint: string;
    private readonly model: string;
    private readonly apiKey: string;
    private readonly inputType: string;
    private readonly queryInputType: string;
    private readonly queryPrefix: string;
    private readonly documentPrefix: string;
    private readonly truncate: string;
    private initialized = false;

    // Circuit breaker state (per provider instance — resets when config
    // changes because a new provider instance is created).
    private failureTimes: number[] = [];
    private circuitOpenUntil = 0;
    private openLogged = false;
    /** One-shot guard so a persistent model substitution doesn't flood the log
     *  with one line per batch. Resets with the provider instance (i.e. on any
     *  config change), so a corrected config logs again if it regresses. */
    private modelMismatchLogged = false;
    private lastFailureReason: EmbeddingFailure | null = null;
    /** True while a half-open probe is in flight. Only the caller who set this
     *  to true is allowed to make a real HTTP call; everyone else short-
     *  circuits as if the circuit were still OPEN. */
    private halfOpenProbeInFlight = false;
    private queryTruncationLogged = false;

    constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.model = options.model?.trim() ?? "";
        this.apiKey = options.apiKey?.trim() ?? "";
        this.inputType = options.inputType?.trim() ?? "";
        this.queryInputType = options.queryInputType?.trim() ?? "";
        const prefixes = resolveEmbeddingTextPrefixes(
            this.model,
            options.queryInstruction,
            options.documentPrefix,
        );
        this.queryPrefix = prefixes.queryPrefix;
        this.documentPrefix = prefixes.documentPrefix;
        this.truncate = options.truncate?.trim() ?? "";
        this.maxInputTokens =
            typeof options.maxInputTokens === "number" && Number.isFinite(options.maxInputTokens)
                ? Math.max(1, Math.floor(options.maxInputTokens))
                : 512;
        this.modelId = getEmbeddingProviderIdentity({
            provider: "openai-compatible",
            endpoint: this.endpoint,
            model: this.model,
            ...(this.apiKey ? { api_key: this.apiKey } : {}),
            ...(this.inputType ? { input_type: this.inputType } : {}),
            // A document prefix changes stored vectors and MUST mirror
            // getEmbeddingProviderIdentity exactly. Preserve an explicit empty
            // override because it disables families such as Nomic whose default
            // document prefix is non-empty.
            ...(options.documentPrefix !== undefined
                ? { document_prefix: options.documentPrefix }
                : {}),
            // truncate participates in identity (it changes which text an
            // over-long input embeds). A missing field here makes the provider
            // write under a different model_id than reads/GC resolve.
            ...(this.truncate ? { truncate: this.truncate } : {}),
        });
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.model) {
            log(
                "[magic-context] openai-compatible embedding provider is missing endpoint or model",
            );
            this.initialized = false;
            return false;
        }

        // SSRF guard: refuse cloud-metadata / link-local endpoints. Memory
        // content (which can carry captured secrets) is the request body, and
        // the endpoint can be influenced by project config. Loopback + private
        // LAN ranges stay allowed so self-hosted embeddings (LMStudio/Ollama)
        // keep working.
        const blockedReason = blockedEmbeddingEndpointReason(this.endpoint);
        if (blockedReason) {
            log(`[magic-context] embedding endpoint blocked: ${blockedReason}`);
            this.initialized = false;
            return false;
        }

        this.initialized = true;
        return true;
    }

    private resolveInputTypeForPurpose(purpose: EmbeddingPurpose = "passage"): string {
        if (purpose === "query") {
            return this.queryInputType || this.inputType;
        }
        return this.inputType;
    }

    async embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null> {
        const [embedding] = await this.embedBatch([text], signal, purpose);
        return embedding ?? null;
    }

    async embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        // Coerce empty / whitespace-only inputs to a single space before the POST.
        // Some OpenAI-compatible providers (e.g. jina via litellm) reject an empty
        // string with HTTP 400 "Input content cannot be empty", which fails the
        // WHOLE batch (the response is all-null) — so one empty input would block
        // embedding every other text sent with it. A space embeds fine (verified)
        // and yields a stable near-zero-information vector. Callers should avoid
        // sending empty content where possible, but this is the single chokepoint
        // that guarantees a stray empty string can't 400 the request.
        const textPrefix = purpose === "query" ? this.queryPrefix : this.documentPrefix;
        const requestTexts = texts.map((text) => {
            const input = `${textPrefix}${text.trim().length === 0 ? " " : text}`;
            const capped = capEmbeddingInput(input, this.maxInputTokens, purpose);
            if (
                purpose === "query" &&
                capped.length < input.length &&
                !this.queryTruncationLogged
            ) {
                log(
                    `[magic-context] embedding query truncated from ${input.length} to ${capped.length} characters to fit max_input_tokens`,
                );
                this.queryTruncationLogged = true;
            }
            return capped;
        });

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        // Pre-flight: caller already gave up? Don't bother making a request.
        if (signal?.aborted) {
            return Array.from({ length: texts.length }, () => null);
        }

        // Circuit check — and, if transitioning to half-open, claim the probe slot.
        // Both the claim AND the AbortController setup run inside try/finally so
        // that the half-open probe slot is guaranteed to be released even if any
        // intermediate step throws. Previously the claim was outside the try,
        // which was safe in practice (non-throwable code between claim and try)
        // but structurally fragile — a future refactor could introduce a throw
        // point and permanently wedge the circuit in half-open.
        let isProbe = false;
        let internalController: AbortController | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let onOuterAbort: (() => void) | undefined;

        try {
            const claim = this.claimProbeOrShortCircuit();
            if (claim === "short_circuit") {
                return Array.from({ length: texts.length }, () => null);
            }
            isProbe = claim === "probe";
            // Set up an AbortController that fires on EITHER the caller's
            // signal OR our internal fetch timeout. This lets a 3s auto-search
            // timeout cancel the underlying HTTP POST instead of leaving it
            // dangling for the full 30s FETCH_TIMEOUT_MS.
            internalController = new AbortController();
            timeoutHandle = setTimeout(() => internalController?.abort(), FETCH_TIMEOUT_MS);
            onOuterAbort = () => internalController?.abort();
            if (signal) {
                signal.addEventListener("abort", onOuterAbort, { once: true });
            }

            const inputTypeForRequest = this.resolveInputTypeForPurpose(purpose);
            const response = await fetch(`${this.endpoint}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    input: requestTexts,
                    // Optional provider-specific fields (e.g. NVIDIA NIM requires
                    // input_type; truncate is accepted by several providers).
                    // Omitted entirely when unset so standard OpenAI endpoints are
                    // unaffected.
                    ...(inputTypeForRequest ? { input_type: inputTypeForRequest } : {}),
                    ...(this.truncate ? { truncate: this.truncate } : {}),
                }),
                // SSRF: refuse to FOLLOW redirects. The pre-flight SSRF check only
                // validates the configured endpoint; default redirect-follow would
                // let an allowed host 307/308 the bearer token + memory content to
                // a link-local/metadata target. A legitimate /embeddings POST never
                // redirects, so `redirect: "error"` rejects the response instead.
                redirect: "error",
                signal: internalController.signal,
            });

            if (!response.ok) {
                const excerpt = await response.text().catch(() => "");
                const failure = this.failure(
                    "http_error",
                    `HTTP ${response.status} from endpoint${this.bodyExcerpt(excerpt)}`,
                    response.status >= 500 || response.status === 408 || response.status === 429,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }

            // Read body as text first so we can produce useful diagnostics on
            // empty / malformed responses (LMStudio / Cerebras / Fireworks
            // sometimes return a 200 status with an empty body when the model
            // is overloaded or the upstream connection dropped mid-response).
            const rawBody = await response.text();
            if (rawBody.trim().length === 0) {
                const failure = this.failure("invalid_envelope", "response body was empty", false);
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }
            let body: EmbeddingResponseBody;
            try {
                body = JSON.parse(rawBody) as EmbeddingResponseBody;
            } catch {
                const failure = this.failure(
                    "invalid_envelope",
                    `response body was not valid JSON${this.bodyExcerpt(rawBody)}`,
                    false,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }
            // Model-substitution guard. A local server (LMStudio/Ollama) can
            // return HTTP 200 with a DIFFERENT model's vectors when the
            // requested model isn't the one currently loaded — e.g. a shared
            // endpoint where another tool keeps a smaller embedding model hot.
            // The substituted vectors have a different dimensionality and live
            // in a different vector space, so storing them under our requested
            // model's identity silently corrupts the index. Refuse the result
            // instead of trusting the substitute.
            const servedModel = typeof body.model === "string" ? body.model : "";
            if (this.model && servedModel && !embeddingModelsMatch(servedModel, this.model)) {
                if (!this.modelMismatchLogged) {
                    log(
                        `[magic-context] embedding endpoint served a DIFFERENT model than requested — refusing the substituted vectors (they have the wrong dimensions/space). requested="${sanitizeDiagnosticText(this.model)}" served="${sanitizeDiagnosticText(servedModel)}". Check that the endpoint serves the requested model; variant suffixes and vendor prefixes are matched automatically.`,
                    );
                    this.modelMismatchLogged = true;
                }
                this.recordFailure(
                    isProbe,
                    this.failure(
                        "substitution_rejected",
                        `served model '${sanitizeDiagnosticText(servedModel)}' does not match requested '${sanitizeDiagnosticText(this.model)}' (substitution guard)`,
                        false,
                    ),
                );
                return Array.from({ length: texts.length }, () => null);
            }

            const responseKeys = Object.keys(body).sort();
            if (!Array.isArray(body.data)) {
                const failure = this.failure(
                    "invalid_envelope",
                    `response had keys [${responseKeys.join(", ")}] but data[] was absent`,
                    false,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }
            if (body.data.length === 0) {
                const failure = this.failure("empty_result", "response data[] was empty", true);
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }

            const slots = responseSlots(body.data, texts.length);
            if (!slots) {
                const failure = this.failure(
                    "invalid_envelope",
                    "response data[].index values were missing, duplicated or out of range",
                    false,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
                return Array.from({ length: texts.length }, () => null);
            }
            const results: (Float32Array | null)[] = Array.from(
                { length: texts.length },
                () => null,
            );
            body.data.forEach((item, position) => {
                const embedding = item?.embedding;
                const slot = slots[position];
                if (slot !== undefined && slot < results.length && Array.isArray(embedding)) {
                    results[slot] = Float32Array.from(embedding);
                }
            });

            // A response with no usable vectors is still a failure — the
            // endpoint is up but not actually embedding.
            if (results.every((r) => r === null)) {
                const failure = this.failure(
                    "invalid_envelope",
                    `response had keys [${responseKeys.join(", ")}] but data[].embedding was absent`,
                    false,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
            } else {
                this.recordSuccess();
            }

            return results;
        } catch (error) {
            // AbortError (our fetch timeout or outer caller abort) lands here too.
            const isAbort =
                error instanceof Error &&
                (error.name === "AbortError" || error.message.includes("aborted"));
            if (isAbort) {
                // Distinguish outer-caller abort (not our problem — don't penalize
                // the endpoint) from our internal timeout (endpoint is slow).
                if (signal?.aborted) {
                    // Caller gave up. Don't count this against the endpoint.
                    // Half-open probe slot is released without state change so
                    // the next real call can probe again.
                } else {
                    log(
                        `[magic-context] openai-compatible embedding request timed out after ${FETCH_TIMEOUT_MS}ms`,
                    );
                    const failure = this.failure(
                        "transport_error",
                        `request timed out after ${FETCH_TIMEOUT_MS}ms`,
                        true,
                    );
                    this.recordFailure(isProbe, failure);
                }
            } else {
                const detail = error instanceof Error ? error.message : String(error);
                const failure = this.failure(
                    "transport_error",
                    `transport error: ${sanitizeDiagnosticText(detail)}`,
                    true,
                );
                log(
                    `[magic-context] openai-compatible embedding request failed: ${failure.reason}`,
                );
                this.recordFailure(isProbe, failure);
            }
            return Array.from({ length: texts.length }, () => null);
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            if (signal && onOuterAbort) {
                signal.removeEventListener("abort", onOuterAbort);
            }
            if (isProbe) {
                this.halfOpenProbeInFlight = false;
            }
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
    }

    isLoaded(): boolean {
        return this.initialized;
    }

    /**
     * Decide what this caller should do:
     *   - "allow":         CLOSED — proceed with a real request, not as a probe
     *   - "probe":         HALF_OPEN — this caller owns the probe slot
     *   - "short_circuit": OPEN or half-open probe already in flight — return nulls
     *
     * Claiming the probe slot (setting `halfOpenProbeInFlight = true`) is done
     * here, synchronously, so concurrent callers see the flag and short-circuit.
     */
    private claimProbeOrShortCircuit(): "allow" | "probe" | "short_circuit" {
        if (this.circuitOpenUntil === 0) {
            // CLOSED — normal operation.
            return "allow";
        }
        if (Date.now() < this.circuitOpenUntil) {
            // OPEN — short-circuit.
            return "short_circuit";
        }
        // Open timer elapsed — transition to HALF_OPEN.
        if (this.halfOpenProbeInFlight) {
            // Someone else is already probing; short-circuit.
            return "short_circuit";
        }
        // Claim the probe slot. Do NOT reset circuitOpenUntil yet — that
        // happens on probe success via recordSuccess(). If the probe fails,
        // recordFailure() will push circuitOpenUntil forward.
        this.halfOpenProbeInFlight = true;
        log(
            `[magic-context] openai-compatible embedding: circuit half-open, probing endpoint after ${this.lastFailureReason?.reason ?? "unknown failure"}`,
        );
        return "probe";
    }

    private failure(
        failureClass: EmbeddingFailureClass,
        reason: string,
        retryable: boolean,
    ): EmbeddingFailure {
        return { class: failureClass, reason, retryable };
    }

    private bodyExcerpt(body: string): string {
        const excerpt = sanitizeDiagnosticText(body).replace(/\s+/g, " ").trim().slice(0, 200);
        return excerpt ? `: ${excerpt}` : "";
    }

    private recordFailure(isProbe: boolean, failure?: EmbeddingFailure): void {
        if (failure) this.lastFailureReason = failure;
        if (isProbe) {
            // Canonical half-open: single probe failure re-opens the circuit.
            this.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: probe failed (${failure?.reason ?? this.lastFailureReason?.reason ?? "unknown failure"}), re-opening circuit for ${OPEN_DURATION_MS / 60_000}min`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
            return;
        }

        const now = Date.now();
        const cutoff = now - FAILURE_WINDOW_MS;
        this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
        this.failureTimes.push(now);

        if (this.failureTimes.length >= FAILURE_THRESHOLD) {
            this.circuitOpenUntil = now + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: opening circuit for ${OPEN_DURATION_MS / 60_000}min after ${this.failureTimes.length} failures in ${FAILURE_WINDOW_MS / 1_000}s (${failure?.reason ?? this.lastFailureReason?.reason ?? "unknown failure"})`,
                );
                this.openLogged = true;
            }
            // Clear the window; when the circuit half-opens later we start
            // counting fresh.
            this.failureTimes = [];
        }
    }

    private recordSuccess(): void {
        if (this.failureTimes.length > 0 || this.circuitOpenUntil > 0 || this.openLogged) {
            log("[magic-context] openai-compatible embedding: endpoint recovered, circuit closed");
        }
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.lastFailureReason = null;
    }

    getLastFailureReason(): EmbeddingFailure | null {
        return this.lastFailureReason;
    }

    // Test-only hooks.
    _getCircuitState(): CircuitState {
        if (this.circuitOpenUntil === 0) return "closed";
        if (Date.now() < this.circuitOpenUntil) {
            return this.halfOpenProbeInFlight ? "half_open" : "open";
        }
        // Timer elapsed but no probe has been issued yet — logically half-open.
        return "half_open";
    }
    _getFailureCount(): number {
        return this.failureTimes.length;
    }
    _resetCircuit(): void {
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.halfOpenProbeInFlight = false;
        this.lastFailureReason = null;
    }
}
