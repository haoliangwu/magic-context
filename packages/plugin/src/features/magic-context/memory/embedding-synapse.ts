import { createHash } from "node:crypto";
import { connectionFileExists, SubcCallError, SubcClient } from "@cortexkit/subc-client";
import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import type { EmbeddingFailure } from "./embedding-failure";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";

export const SYNAPSE_DEFAULT_MODEL = "gte-modernbert-base-f16";
export const SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS = 3_000;
export const SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS = 120_000;

export type SynapseErrorCode =
    | "queue_full"
    | "model_loading"
    | "transport"
    | "timeout"
    | "artifact_invalid"
    | "substitution_rejected"
    | "not_certified"
    | "probe_required"
    | "idempotency_conflict"
    | "schema_violation"
    | "module_restarted"
    | "certification_refused"
    | "needs_reauth";

// Synapse's drift-guarded error vocabulary was mechanically extracted from
// synapse@c43cd33 crates/synapse-core/src/error_contract.rs (Errors). Keep this
// snapshot together so a newly documented refusal is an explicit review diff.
export const SYNAPSE_ERROR_VOCABULARY = [
    "deadline_exceeded",
    "not_certified",
    "substitution_rejected",
    "artifact_invalid",
    "owned_cuda_unsupported",
    "probe_required",
    "migration_required",
    "module_restarted",
    "invalid_request",
    "declared_identity_not_accepted",
    "remote_identity_drift",
    "provider_protocol_violation",
    "idempotency_conflict",
    "needs_reauth",
    "needs_reauth_expired",
    "remote_deployment_changed",
    "credential_config_invalid",
    "op_not_supported_for_remote",
    "sentinel_calibration_refused",
] as const;

const SYNAPSE_CERTIFICATION_REFUSAL_REASONS = new Set([
    "not_certified",
    "probe_required",
    "migration_required",
]);

export type SynapseMaxTokensSource =
    | "runtime_bucket"
    | "worker_bucket"
    | "catalog"
    | "catalog_unloaded";

export interface SynapseCatalogEntry {
    model: string;
    fingerprint: string;
    table_epoch: number;
    /** Per-row ceiling advertised by this lane. */
    max_tokens: number;
    max_tokens_source: SynapseMaxTokensSource;
    bucket_ladder?: number[];
    dims?: number;
    dtype?: string;
    device_class?: string;
    /** Rows per embed.batch call, from the service's measured per-lane policy. */
    recommended_batch?: number;
    /** Aggregate token budget from the service's measured batch policy. */
    recommended_token_budget?: number;
    provenance?: unknown;
    certified?: boolean;
    status?: string;
    warm_load_cost_hint_ms?: number;
}

export interface SynapseLaneMetadata extends SynapseCatalogEntry {
    laneIdentity: string;
}

export interface SynapseLaneDescriptor {
    lane: string;
    device_class?: string;
    max_tokens: number;
    max_tokens_source: SynapseMaxTokensSource;
    bucket_ladder?: number[];
    dims?: number;
    dtype?: string;
    certified?: boolean;
    warm_load_cost_hint_ms?: number;
    recommended_batch?: { rows: number; token_budget?: number };
    /** True only when the ceiling came from a loaded runtime or worker bucket. */
    warm: boolean;
}

export interface SynapseEmbeddingRowMetadata {
    truncated: boolean;
    submittedSha256: string;
    contentSha256: string;
    effectiveTokens?: number;
}

const embeddingRowMetadata = new WeakMap<Float32Array, SynapseEmbeddingRowMetadata>();

export function getSynapseEmbeddingRowMetadata(
    vector: Float32Array,
): SynapseEmbeddingRowMetadata | undefined {
    return embeddingRowMetadata.get(vector);
}

export function isSynapseEmbeddingTruncated(vector: Float32Array): boolean {
    return embeddingRowMetadata.get(vector)?.truncated === true;
}

export function toSynapseLaneDescriptor(metadata: SynapseCatalogEntry): SynapseLaneDescriptor {
    const tokenBudget = metadata.recommended_token_budget;
    return {
        lane: metadata.model,
        ...(metadata.device_class ? { device_class: metadata.device_class } : {}),
        max_tokens: metadata.max_tokens,
        max_tokens_source: metadata.max_tokens_source,
        ...(metadata.bucket_ladder ? { bucket_ladder: [...metadata.bucket_ladder] } : {}),
        ...(metadata.dims ? { dims: metadata.dims } : {}),
        ...(metadata.dtype ? { dtype: metadata.dtype } : {}),
        ...(typeof metadata.certified === "boolean" ? { certified: metadata.certified } : {}),
        ...(metadata.warm_load_cost_hint_ms !== undefined
            ? { warm_load_cost_hint_ms: metadata.warm_load_cost_hint_ms }
            : {}),
        ...(metadata.recommended_batch
            ? {
                  recommended_batch: {
                      rows: metadata.recommended_batch,
                      ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
                  },
              }
            : {}),
        warm:
            metadata.max_tokens_source === "runtime_bucket" ||
            metadata.max_tokens_source === "worker_bucket",
    };
}

export function formatSynapseLaneDescriptor(descriptor: SynapseLaneDescriptor): string {
    const certified = descriptor.certified === undefined ? "unknown" : String(descriptor.certified);
    return (
        `lane=${descriptor.lane}; device_class=${descriptor.device_class ?? "unknown"}; ` +
        `max_tokens=${descriptor.max_tokens} (${descriptor.max_tokens_source}); ` +
        `certified=${certified}; warm=${descriptor.warm ? "yes" : "no"}; ` +
        `warm_load_cost_hint_ms=${descriptor.warm_load_cost_hint_ms ?? "unknown"}`
    );
}

export interface SynapseClientLike {
    call<Response = unknown>(
        moduleId: string,
        method: string,
        params?: unknown,
        options?: {
            timeoutMs?: number;
            identity?: { project_root: string; harness: string; session: string };
            targetKind?: "management_surface" | "tool_provider";
        },
    ): Promise<Response>;
    close(): void;
}

export interface SynapseEmbeddingProviderOptions {
    connectionFile: string;
    projectRoot: string;
    session: string;
    model?: string;
    fingerprint?: string;
    tableEpoch?: number;
    dims?: number;
    recommendedBatch?: number;
    recommendedTokenBudget?: number;
    descriptor?: SynapseLaneDescriptor;
    metadata?: SynapseLaneMetadata;
    provenance?: unknown;
    moduleId?: string;
    queryTimeoutMs?: number;
    batchTimeoutMs?: number;
    clientFactory?: () => Promise<SynapseClientLike>;
}

export class SynapseEmbeddingError extends Error {
    readonly code: SynapseErrorCode;
    readonly retryAfterMs?: number;
    readonly permanent: boolean;
    /** Typed SYNAPSE reason carried by a certification_refused Error-frame detail. */
    readonly refusalReason?: string;

    constructor(
        code: SynapseErrorCode,
        message: string,
        options?: {
            retryAfterMs?: number;
            permanent?: boolean;
            cause?: unknown;
            refusalReason?: string;
        },
    ) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "SynapseEmbeddingError";
        this.code = code;
        this.permanent = options?.permanent ?? isPermanentSynapseCode(code);
        this.retryAfterMs = options?.retryAfterMs ?? (this.permanent ? undefined : 100);
        this.refusalReason = options?.refusalReason;
    }
}

function isPermanentSynapseCode(code: string): boolean {
    return (
        code === "artifact_invalid" ||
        code === "substitution_rejected" ||
        code === "not_certified" ||
        code === "probe_required" ||
        code === "idempotency_conflict" ||
        code === "schema_violation" ||
        code === "certification_refused" ||
        code === "needs_reauth"
    );
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function responseBody(value: unknown): Record<string, unknown> {
    const record = asRecord(value);
    const result = asRecord(record?.result);
    const payload = asRecord(result?.payload ?? record?.payload);
    return {
        ...(record ?? {}),
        ...(result ?? {}),
        ...(payload ?? {}),
    };
}

function readRetryAfter(value: unknown): number | undefined {
    const record = asRecord(value);
    const candidate = record?.retry_after_ms ?? record?.retryAfterMs;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
        return undefined;
    return Math.ceil(candidate);
}

function readErrorCode(value: unknown): string | undefined {
    const record = asRecord(value);
    if (typeof record?.code === "string") return record.code;
    if (value instanceof Error && "code" in value && typeof value.code === "string") {
        return value.code;
    }
    return undefined;
}

function readCertificationRefusalReason(value: unknown): string | undefined {
    // subc-client >=0.10.0 retains ErrorBody.detail on the managed-call error.
    // Do not recover a typed reason from `code`: SYNAPSE keeps that field as the
    // coarse class, and older clients have no detail to recover.
    if (!(value instanceof SubcCallError)) return undefined;
    const detail = (value as SubcCallError & { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    const record = asRecord(detail);
    return typeof record?.reason === "string" ? record.reason : undefined;
}

function classifyError(value: unknown): SynapseEmbeddingError {
    if (value instanceof SynapseEmbeddingError) return value;
    const code = readErrorCode(value) ?? (value instanceof Error ? value.name : "transport");
    const normalized = code.toLowerCase();
    const refusalReason = readCertificationRefusalReason(value);
    let mapped: SynapseErrorCode = "transport";
    if (normalized.includes("queue_full")) mapped = "queue_full";
    else if (normalized.includes("model_loading")) mapped = "model_loading";
    else if (normalized.includes("timeout") || normalized.includes("deadline")) mapped = "timeout";
    else if (normalized.includes("artifact_invalid")) mapped = "artifact_invalid";
    else if (normalized.includes("substitution")) mapped = "substitution_rejected";
    else if (normalized === "certification_refused") mapped = "certification_refused";
    else if (normalized.includes("not_certified")) mapped = "not_certified";
    else if (normalized.includes("probe_required")) mapped = "probe_required";
    else if (normalized.includes("idempotency_conflict")) mapped = "idempotency_conflict";
    else if (normalized.includes("needs_reauth")) mapped = "needs_reauth";
    else if (normalized.includes("schema")) mapped = "schema_violation";
    else if (normalized.includes("module_restarted") || normalized.includes("module restarted"))
        mapped = "module_restarted";
    const message = value instanceof Error ? value.message : String(value);
    return new SynapseEmbeddingError(mapped, message, {
        retryAfterMs: readRetryAfter(value) ?? (isPermanentSynapseCode(mapped) ? undefined : 100),
        cause: value,
        refusalReason,
    });
}

function embeddingFailureFor(error: SynapseEmbeddingError): EmbeddingFailure {
    const typedReason = error.refusalReason;
    if (
        (typedReason !== undefined && SYNAPSE_CERTIFICATION_REFUSAL_REASONS.has(typedReason)) ||
        error.code === "not_certified" ||
        error.code === "probe_required"
    ) {
        return {
            class: "certification_refusal",
            reason: `SYNAPSE certification refused embedding: ${typedReason ?? error.code}`,
            retryable: false,
        };
    }
    // A coarse certification_refused code without a recognized detail means the
    // service is newer than this checked-in vocabulary snapshot. It is still a
    // refusal, never a transport failure, and preserves the raw new detail.
    if (error.code === "certification_refused") {
        return {
            class: "certification_refusal",
            reason: `SYNAPSE certification refused embedding: ${typedReason ?? "unknown reason"}`,
            retryable: false,
        };
    }
    if (typedReason === "needs_reauth" || typedReason === "needs_reauth_expired") {
        return {
            class: "credential_required",
            reason: "SYNAPSE requires reauthentication",
            retryable: false,
        };
    }
    if (error.code === "substitution_rejected") {
        return { class: "substitution_rejected", reason: error.message, retryable: false };
    }
    if (error.code === "schema_violation" || error.code === "artifact_invalid") {
        return { class: "invalid_envelope", reason: error.message, retryable: false };
    }
    return { class: "transport_error", reason: error.message, retryable: !error.permanent };
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

export function getSynapseLaneIdentity(model: string, fingerprint: string): string {
    return `synapse:v1:${sha256(stableJson({ model, fingerprint }))}`;
}

export function getSynapseBatchRequestKey(args: {
    model: string;
    fingerprint: string;
    tableEpoch: number;
    items: readonly { id: string; contentSha256: string }[];
    purpose?: EmbeddingPurpose;
}): string {
    return sha256(
        stableJson({
            op: "embed.batch",
            model: args.model,
            required_fingerprint: args.fingerprint,
            required_epoch: args.tableEpoch,
            allow_equivalent: false,
            ids: args.items.map((item) => item.id),
            content_sha256: args.items.map((item) => item.contentSha256),
            ...(args.purpose === "query" ? { purpose: args.purpose } : {}),
        }),
    );
}

function hashContent(text: string): string {
    return sha256(text);
}

function extractCatalogEntries(value: unknown): SynapseCatalogEntry[] {
    const body = responseBody(value);
    const raw = Array.isArray(body.models)
        ? body.models
        : Array.isArray(body.entries)
          ? body.entries
          : Array.isArray(value)
            ? value
            : [];
    const envelopeEpoch =
        typeof body.table_epoch === "number" && Number.isInteger(body.table_epoch)
            ? body.table_epoch
            : undefined;
    const maxTokenSources = new Set<SynapseMaxTokensSource>([
        "runtime_bucket",
        "worker_bucket",
        "catalog",
        "catalog_unloaded",
    ]);

    return raw.flatMap((entry) => {
        const record = asRecord(entry);
        if (!record) return [];
        const model =
            typeof record.model === "string" && record.model.length > 0
                ? record.model
                : typeof record.model_id === "string"
                  ? record.model_id
                  : "";
        const fingerprint =
            typeof record.fingerprint === "string" && record.fingerprint.length > 0
                ? record.fingerprint
                : Array.isArray(record.fingerprints) && typeof record.fingerprints[0] === "string"
                  ? record.fingerprints[0]
                  : "";
        const entryEpoch = record.table_epoch ?? record.tableEpoch;
        const tableEpoch =
            typeof entryEpoch === "number" && Number.isInteger(entryEpoch)
                ? entryEpoch
                : envelopeEpoch;
        const maxTokens = record.max_tokens;
        const maxTokensSource = record.max_tokens_source;
        if (
            model.length === 0 ||
            fingerprint.length === 0 ||
            typeof tableEpoch !== "number" ||
            !Number.isInteger(tableEpoch) ||
            typeof maxTokens !== "number" ||
            !Number.isInteger(maxTokens) ||
            maxTokens <= 0 ||
            typeof maxTokensSource !== "string" ||
            !maxTokenSources.has(maxTokensSource as SynapseMaxTokensSource)
        ) {
            return [];
        }

        const dims = record.dims ?? record.dimensions;
        const rawBatch = record.recommended_batch ?? record.recommendedBatch;
        const batchRecord = asRecord(rawBatch);
        const recommendedBatch =
            typeof rawBatch === "number" ? rawBatch : batchRecord ? batchRecord.rows : undefined;
        const recommendedTokenBudget = batchRecord ? batchRecord.token_budget : undefined;
        const bucketLadder = Array.isArray(record.bucket_ladder)
            ? record.bucket_ladder.filter(
                  (bucket): bucket is number =>
                      typeof bucket === "number" && Number.isInteger(bucket) && bucket > 0,
              )
            : undefined;
        const state = typeof record.state === "string" ? record.state : undefined;
        const warmLoadCostHint = record.warm_load_cost_hint_ms;

        return [
            {
                model,
                fingerprint,
                table_epoch: tableEpoch,
                max_tokens: maxTokens,
                max_tokens_source: maxTokensSource as SynapseMaxTokensSource,
                ...(bucketLadder && bucketLadder.length > 0
                    ? { bucket_ladder: [...new Set(bucketLadder)].sort((a, b) => a - b) }
                    : {}),
                ...(typeof dims === "number" && Number.isInteger(dims) && dims > 0 ? { dims } : {}),
                ...(typeof record.dtype === "string" && record.dtype.length > 0
                    ? { dtype: record.dtype }
                    : {}),
                ...(typeof record.device_class === "string" && record.device_class.length > 0
                    ? { device_class: record.device_class }
                    : {}),
                ...(typeof recommendedBatch === "number" && recommendedBatch > 0
                    ? { recommended_batch: Math.floor(recommendedBatch) }
                    : {}),
                ...(typeof recommendedTokenBudget === "number" && recommendedTokenBudget > 0
                    ? { recommended_token_budget: Math.floor(recommendedTokenBudget) }
                    : {}),
                ...(record.provenance !== undefined ? { provenance: record.provenance } : {}),
                ...(typeof record.certified === "boolean" ? { certified: record.certified } : {}),
                ...(typeof warmLoadCostHint === "number" &&
                Number.isFinite(warmLoadCostHint) &&
                warmLoadCostHint >= 0
                    ? { warm_load_cost_hint_ms: warmLoadCostHint }
                    : {}),
                ...(typeof record.status === "string"
                    ? { status: record.status }
                    : state
                      ? { status: state }
                      : {}),
            },
        ];
    });
}

function extractVector(value: unknown): {
    vector: Float32Array;
    item: Record<string, unknown>;
    disclosure: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
} | null {
    const body = responseBody(value);
    const item = Array.isArray(body.vectors) ? asRecord(body.vectors[0]) : null;
    const raw = item?.vector;
    if (
        !item ||
        !Array.isArray(raw) ||
        raw.some((component) => typeof component !== "number" || !Number.isFinite(component))
    ) {
        return null;
    }
    const disclosure = Array.isArray(body.truncation_disclosures)
        ? asRecord(body.truncation_disclosures[0])
        : null;
    return { vector: Float32Array.from(raw), item, disclosure, metadata: body };
}

function extractBatchItems(value: unknown): Array<Record<string, unknown>> {
    const body = responseBody(value);
    const raw = Array.isArray(body.vectors)
        ? body.vectors
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.results)
            ? body.results
            : [];
    return raw.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
    });
}

function extractTruncationDisclosures(value: unknown): Array<Record<string, unknown> | null> {
    const body = responseBody(value);
    if (!Array.isArray(body.truncation_disclosures)) return [];
    return body.truncation_disclosures.map((disclosure) => asRecord(disclosure));
}

function validateWireRow(
    item: Record<string, unknown>,
    disclosure: Record<string, unknown> | null,
    expected: { id: string; text: string },
): SynapseEmbeddingRowMetadata {
    const submittedSha256 = item.submitted_sha256;
    const contentSha256 = item.content_sha256;
    const expectedSubmittedSha256 = hashContent(expected.text);
    if (typeof submittedSha256 !== "string") {
        throw new SynapseEmbeddingError(
            "schema_violation",
            `Synapse item ${expected.id} omitted submitted_sha256`,
        );
    }
    if (submittedSha256 !== expectedSubmittedSha256) {
        throw new SynapseEmbeddingError(
            "schema_violation",
            `Synapse submitted hash mismatch for item ${expected.id}`,
        );
    }
    if (typeof contentSha256 !== "string") {
        throw new SynapseEmbeddingError(
            "schema_violation",
            `Synapse item ${expected.id} omitted content_sha256`,
        );
    }

    const hashesDiffer = contentSha256 !== submittedSha256;
    const disclosedTruncation = disclosure?.truncated === true;
    const effectiveTokens = disclosure?.effective_tokens;
    if (
        disclosure &&
        (typeof disclosure.truncated !== "boolean" ||
            typeof effectiveTokens !== "number" ||
            !Number.isInteger(effectiveTokens) ||
            effectiveTokens < 0)
    ) {
        throw new SynapseEmbeddingError(
            "schema_violation",
            `Synapse item ${expected.id} returned an invalid truncation disclosure`,
        );
    }
    if (hashesDiffer) {
        if (
            !disclosedTruncation ||
            typeof effectiveTokens !== "number" ||
            !Number.isInteger(effectiveTokens) ||
            effectiveTokens < 0
        ) {
            throw new SynapseEmbeddingError(
                "schema_violation",
                `Synapse item ${expected.id} changed content without a valid truncation disclosure`,
            );
        }
    } else if (disclosedTruncation) {
        throw new SynapseEmbeddingError(
            "schema_violation",
            `Synapse item ${expected.id} disclosed truncation but returned matching hashes`,
        );
    }

    return {
        truncated: hashesDiffer,
        submittedSha256,
        contentSha256,
        ...(typeof effectiveTokens === "number" &&
        Number.isInteger(effectiveTokens) &&
        effectiveTokens >= 0
            ? { effectiveTokens }
            : {}),
    };
}

let sharedClient: SynapseClientLike | null = null;
let sharedClientFile: string | null = null;
let sharedClientPromise: Promise<SynapseClientLike> | null = null;

const factoryClients = new WeakMap<() => Promise<SynapseClientLike>, Promise<SynapseClientLike>>();

async function getSharedClient(
    options: SynapseEmbeddingProviderOptions,
): Promise<SynapseClientLike> {
    if (options.clientFactory) {
        // Factory clients (tests, embedded fixtures) memoize per factory, never
        // in the module-global slot: a cached fixture client would otherwise
        // leak across providers and poison every later real connection in the
        // same process.
        let promise = factoryClients.get(options.clientFactory);
        if (!promise) {
            promise = options.clientFactory();
            factoryClients.set(options.clientFactory, promise);
        }
        return promise;
    }
    if (sharedClient && sharedClientFile === options.connectionFile) return sharedClient;
    if (sharedClientPromise && sharedClientFile === options.connectionFile)
        return sharedClientPromise;
    sharedClientFile = options.connectionFile;
    sharedClientPromise = inRootAsyncContext(() =>
        SubcClient.connect({ connectionFile: options.connectionFile }),
    ).then((client) => {
        sharedClient = client;
        return client;
    });
    return sharedClientPromise;
}

export class SynapseEmbeddingProvider implements EmbeddingProvider {
    modelId: string;
    metadata: SynapseLaneMetadata | null;

    get maxInputTokens(): number | undefined {
        return this.metadata?.max_tokens;
    }

    private readonly options: SynapseEmbeddingProviderOptions;
    private client: SynapseClientLike | null = null;
    private initialized = false;
    private initializing: Promise<boolean> | null = null;
    private permanentFailure = false;
    private lastFailureReason: EmbeddingFailure | null = null;
    private batchLimit = 16;
    private tokenBudget: number | null = null;

    constructor(options: SynapseEmbeddingProviderOptions) {
        this.options = options;
        const model = options.model || SYNAPSE_DEFAULT_MODEL;
        const fingerprint = options.fingerprint ?? "";
        const descriptor = options.descriptor;
        this.metadata = options.metadata
            ? {
                  ...options.metadata,
                  bucket_ladder: options.metadata.bucket_ladder
                      ? [...options.metadata.bucket_ladder]
                      : undefined,
              }
            : fingerprint && Number.isInteger(options.tableEpoch) && descriptor
              ? {
                    model,
                    fingerprint,
                    table_epoch: options.tableEpoch as number,
                    max_tokens: descriptor.max_tokens,
                    max_tokens_source: descriptor.max_tokens_source,
                    ...(descriptor.bucket_ladder
                        ? { bucket_ladder: [...descriptor.bucket_ladder] }
                        : {}),
                    ...((options.dims ?? descriptor.dims)
                        ? { dims: (options.dims ?? descriptor.dims) as number }
                        : {}),
                    ...(descriptor.dtype ? { dtype: descriptor.dtype } : {}),
                    ...(descriptor.device_class ? { device_class: descriptor.device_class } : {}),
                    ...((options.recommendedBatch ?? descriptor.recommended_batch?.rows)
                        ? {
                              recommended_batch: Math.max(
                                  1,
                                  Math.floor(
                                      (options.recommendedBatch ??
                                          descriptor.recommended_batch?.rows) as number,
                                  ),
                              ),
                          }
                        : {}),
                    ...((options.recommendedTokenBudget ??
                    descriptor.recommended_batch?.token_budget)
                        ? {
                              recommended_token_budget: Math.max(
                                  1,
                                  Math.floor(
                                      (options.recommendedTokenBudget ??
                                          descriptor.recommended_batch?.token_budget) as number,
                                  ),
                              ),
                          }
                        : {}),
                    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
                    ...(typeof descriptor.certified === "boolean"
                        ? { certified: descriptor.certified }
                        : {}),
                    ...(descriptor.warm_load_cost_hint_ms !== undefined
                        ? { warm_load_cost_hint_ms: descriptor.warm_load_cost_hint_ms }
                        : {}),
                    laneIdentity: getSynapseLaneIdentity(model, fingerprint),
                }
              : null;
        this.modelId = this.metadata?.laneIdentity ?? "synapse:v1:pending";
        this.batchLimit = this.metadata?.recommended_batch ?? 16;
        this.tokenBudget = this.metadata?.recommended_token_budget ?? null;
    }

    /**
     * Page split honors both halves of the service's measured policy: the row
     * count and aggregate token budget. Per-row eligibility is checked against
     * the lane's separately advertised max_tokens before this method runs.
     */
    private nextPage(
        items: readonly { id: string; text: string; contentSha256: string }[],
        start: number,
    ): readonly { id: string; text: string; contentSha256: string }[] {
        const hardEnd = Math.min(items.length, start + this.batchLimit);
        if (this.tokenBudget === null) return items.slice(start, hardEnd);
        let end = start;
        let tokens = 0;
        while (end < hardEnd) {
            tokens += estimateTokens(items[end].text);
            if (tokens > this.tokenBudget && end > start) break;
            end += 1;
        }
        return items.slice(start, Math.max(end, start + 1));
    }

    static async discover(options: SynapseEmbeddingProviderOptions): Promise<SynapseLaneMetadata> {
        const provider = new SynapseEmbeddingProvider(options);
        if (!(await provider.initialize()) || !provider.metadata) {
            throw new SynapseEmbeddingError("not_certified", "Synapse lane is not ready");
        }
        return provider.metadata;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (this.permanentFailure) return false;
        if (this.initializing) return this.initializing;
        this.initializing = (async () => {
            try {
                if (
                    !this.options.clientFactory &&
                    !(await connectionFileExists(this.options.connectionFile))
                ) {
                    throw new SynapseEmbeddingError(
                        "transport",
                        `Synapse connection file is unavailable: ${this.options.connectionFile}`,
                    );
                }
                this.client = await getSharedClient(this.options);
                if (!this.metadata) {
                    const discovered = await this.callWithRetry<SynapseCatalogEntry[]>(
                        "models.list",
                        {},
                        this.options.queryTimeoutMs ?? SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS,
                        false,
                    );
                    const entries = extractCatalogEntries(discovered);
                    const requested = this.options.model?.trim() || SYNAPSE_DEFAULT_MODEL;
                    const entry = entries.find((candidate) => candidate.model === requested);
                    if (!entry) {
                        throw new SynapseEmbeddingError(
                            "artifact_invalid",
                            `Synapse models.list did not return requested model ${requested}`,
                        );
                    }
                    if (entry.certified === false || entry.status === "not_certified") {
                        throw new SynapseEmbeddingError(
                            "not_certified",
                            `Synapse model ${entry.model} is not certified`,
                        );
                    }
                    const metadata: SynapseLaneMetadata = {
                        ...entry,
                        laneIdentity: getSynapseLaneIdentity(entry.model, entry.fingerprint),
                    };
                    this.metadata = metadata;
                    this.modelId = metadata.laneIdentity;
                    this.batchLimit = metadata.recommended_batch ?? this.batchLimit;
                    this.tokenBudget = metadata.recommended_token_budget ?? this.tokenBudget;
                }
                this.initialized = true;
                this.recordSuccess();
                return true;
            } catch (error) {
                const classified = classifyError(error);
                this.recordFailure(classified);
                if (classified.permanent) {
                    this.permanentFailure = true;
                    log(
                        `[magic-context] Synapse lane disabled: ${classified.code}: ${classified.message}`,
                    );
                } else {
                    log(`[magic-context] Synapse lane unavailable: ${classified.message}`);
                }
                this.initialized = false;
                return false;
            } finally {
                this.initializing = null;
            }
        })();
        return this.initializing;
    }

    async embed(
        text: string,
        signal?: AbortSignal,
        purpose: EmbeddingPurpose = "passage",
    ): Promise<Float32Array | null> {
        if (!(await this.initialize()) || signal?.aborted || !this.metadata) return null;
        if (estimateTokens(text) > this.metadata.max_tokens) return null;
        try {
            const id = "query";
            const value = await this.callWithRetry(
                "embed.query",
                this.requestConstraints({
                    id,
                    text,
                    purpose,
                    deadline_ms: this.options.queryTimeoutMs ?? SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS,
                }),
                this.options.queryTimeoutMs ?? SYNAPSE_DEFAULT_QUERY_TIMEOUT_MS,
                true,
                signal,
            );
            const extracted = extractVector(value);
            if (!extracted) {
                throw new SynapseEmbeddingError(
                    "schema_violation",
                    "Synapse query returned no vector row",
                );
            }
            if (extracted.item.id !== id) {
                throw new SynapseEmbeddingError(
                    "schema_violation",
                    `Synapse query returned unexpected item ${String(extracted.item.id)}`,
                );
            }
            const rowMetadata = validateWireRow(extracted.item, extracted.disclosure, { id, text });
            this.validateResponse(extracted.metadata, extracted.vector.length);
            embeddingRowMetadata.set(extracted.vector, rowMetadata);
            this.recordSuccess();
            return extracted.vector;
        } catch (error) {
            this.logCallFailure(error, "embed.query");
            return null;
        }
    }

    async embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose: EmbeddingPurpose = "passage",
    ): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) return [];
        const items = texts.map((text, index) => ({
            id: `item:${index}`,
            text,
            contentSha256: hashContent(text),
        }));
        const map = await this.embedItems(items, signal, purpose);
        return items.map((item) => map.get(item.id) ?? null);
    }

    async embedItems(
        items: readonly { id: string; text: string; contentSha256: string }[],
        signal?: AbortSignal,
        purpose: EmbeddingPurpose = "passage",
    ): Promise<Map<string, Float32Array>> {
        const output = new Map<string, Float32Array>();
        if (items.length === 0 || !(await this.initialize()) || !this.metadata || signal?.aborted) {
            return output;
        }
        const maxTokens = this.metadata.max_tokens;
        const eligibleItems = items
            .filter((item) => estimateTokens(item.text) <= maxTokens)
            .map((item) => ({ ...item, contentSha256: hashContent(item.text) }));
        for (let start = 0; start < eligibleItems.length; ) {
            if (signal?.aborted || this.permanentFailure) break;
            const page = this.nextPage(eligibleItems, start);
            start += page.length;
            try {
                const requestKey = this.requestKey(page, purpose);
                let body: unknown = {};
                let restarted = false;
                for (;;) {
                    try {
                        body = await this.callWithRetry(
                            "embed.batch",
                            this.batchRequest(page, requestKey, purpose),
                            this.options.batchTimeoutMs ?? SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS,
                            true,
                            signal,
                        );
                        const first = responseBody(body);
                        const jobId = typeof first.job_id === "string" ? first.job_id : null;
                        if (jobId) body = await this.pollBatch(jobId, requestKey, signal);
                        break;
                    } catch (error) {
                        const classified = classifyError(error);
                        if (classified.code !== "module_restarted" || restarted) throw classified;
                        restarted = true;
                    }
                }
                const batchEnvelope = responseBody(body);
                const disclosures = extractTruncationDisclosures(body);
                for (const [index, item] of extractBatchItems(body).entries()) {
                    const id = typeof item.id === "string" ? item.id : "";
                    const vector = item.vector ?? item.embedding;
                    if (
                        !id ||
                        !Array.isArray(vector) ||
                        vector.some(
                            (component) =>
                                typeof component !== "number" || !Number.isFinite(component),
                        )
                    ) {
                        throw new SynapseEmbeddingError(
                            "schema_violation",
                            "Synapse batch item is malformed",
                        );
                    }
                    const expected = page.find((candidate) => candidate.id === id);
                    if (!expected) {
                        throw new SynapseEmbeddingError(
                            "schema_violation",
                            `Synapse returned unknown item ${id}`,
                        );
                    }
                    const rowMetadata = validateWireRow(item, disclosures[index] ?? null, expected);
                    const vectorArray = Float32Array.from(vector);
                    this.validateResponse({ ...batchEnvelope, ...item }, vectorArray.length);
                    embeddingRowMetadata.set(vectorArray, rowMetadata);
                    output.set(id, vectorArray);
                    this.recordSuccess();
                }
            } catch (error) {
                const classified = classifyError(error);
                this.logCallFailure(classified, "embed.batch");
                if (
                    classified.code === "idempotency_conflict" ||
                    classified.code === "schema_violation"
                ) {
                    throw classified;
                }
                if (classified.permanent) {
                    this.permanentFailure = true;
                    this.initialized = false;
                    break;
                }
            }
        }
        return output;
    }

    async dispose(): Promise<void> {
        this.initialized = false;
        this.client = null;
    }

    isLoaded(): boolean {
        return this.initialized;
    }

    getLastFailureReason(): EmbeddingFailure | null {
        return this.lastFailureReason;
    }

    private requestConstraints(extra: Record<string, unknown>): Record<string, unknown> {
        const metadata = this.metadata;
        if (!metadata) return extra;
        return {
            ...extra,
            model: metadata.model,
            required_fingerprint: metadata.fingerprint,
            required_epoch: metadata.table_epoch,
            allow_equivalent: false,
        };
    }

    private batchRequest(
        items: readonly { id: string; text: string; contentSha256: string }[],
        requestKey: string,
        purpose: EmbeddingPurpose,
    ): Record<string, unknown> {
        return this.requestConstraints({
            items: items.map((item) => ({
                id: item.id,
                text: item.text,
                content_sha256: item.contentSha256,
            })),
            request_key: requestKey,
            purpose,
        });
    }

    private requestKey(
        items: readonly { id: string; text: string; contentSha256: string }[],
        purpose: EmbeddingPurpose,
    ): string {
        if (!this.metadata)
            throw new SynapseEmbeddingError("transport", "Synapse metadata is unavailable");
        return getSynapseBatchRequestKey({
            model: this.metadata.model,
            fingerprint: this.metadata.fingerprint,
            tableEpoch: this.metadata.table_epoch,
            items,
            purpose,
        });
    }

    private async pollBatch(
        jobId: string,
        requestKey: string,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let cursor: unknown = null;
        const allItems: Array<Record<string, unknown>> = [];
        const allDisclosures: Array<Record<string, unknown> | null> = [];
        for (;;) {
            if (signal?.aborted) return {};
            const body = await this.callWithRetry(
                "embed.result",
                this.requestConstraints({
                    job_id: jobId,
                    cursor,
                    request_key: requestKey,
                }),
                this.options.batchTimeoutMs ?? SYNAPSE_DEFAULT_BATCH_TIMEOUT_MS,
                true,
                signal,
            );
            const parsed = responseBody(body);
            const items = extractBatchItems(body);
            const disclosures = extractTruncationDisclosures(body);
            allItems.push(...items);
            allDisclosures.push(...items.map((_, index) => disclosures[index] ?? null));
            const nextCursor = parsed.next_cursor ?? parsed.cursor;
            const done =
                parsed.done === true ||
                parsed.complete === true ||
                nextCursor === undefined ||
                nextCursor === null;
            if (done) {
                return {
                    ...parsed,
                    vectors: allItems,
                    truncation_disclosures: allDisclosures,
                };
            }
            cursor = nextCursor;
        }
    }

    private async callWithRetry<T>(
        method: string,
        params: unknown,
        timeoutMs: number,
        retryEmbeddings: boolean,
        signal?: AbortSignal,
    ): Promise<T> {
        let attempt = 0;
        for (;;) {
            if (signal?.aborted)
                throw new SynapseEmbeddingError("transport", "Synapse request aborted");
            try {
                if (!this.client)
                    throw new SynapseEmbeddingError("transport", "Synapse client is unavailable");
                return await this.client.call<T>(
                    this.options.moduleId ?? "synapse",
                    method,
                    params,
                    {
                        timeoutMs,
                        // Synapse registers exactly one provider role, ManagementSurface;
                        // every op (embed.*, models.list, jobs) is dispatched by the JSON
                        // method field over that single route.
                        targetKind: "management_surface",
                        identity: {
                            project_root: this.options.projectRoot,
                            harness: getHarness(),
                            session: this.options.session,
                        },
                    },
                );
            } catch (error) {
                const classified = classifyError(error);
                if (classified.code === "idempotency_conflict") throw classified;
                const outcomeUnknown =
                    error instanceof SubcCallError && error.kind === "outcome_unknown";
                const retryable = !classified.permanent && (retryEmbeddings || !outcomeUnknown);
                if (!retryable || attempt >= 3) throw classified;
                const delay = classified.retryAfterMs ?? Math.min(2_000, 100 * 2 ** attempt);
                attempt += 1;
                await wait(delay);
            }
        }
    }

    private validateResponse(body: Record<string, unknown>, dims: number): void {
        const metadata = this.metadata;
        if (!metadata) {
            throw new SynapseEmbeddingError("artifact_invalid", "Synapse lane metadata missing");
        }
        // The catalog omits dims, so the first embed response pins them; every
        // later response must match the pinned value exactly.
        if (metadata.dims === undefined) {
            const envelopeDims = body.dims;
            if (typeof envelopeDims === "number" && envelopeDims !== dims) {
                throw new SynapseEmbeddingError(
                    "artifact_invalid",
                    `Synapse envelope declares ${envelopeDims} dimensions but the vector has ${dims}`,
                );
            }
            metadata.dims = dims;
        }
        if (dims !== metadata.dims) {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                `Synapse returned ${dims} dimensions, expected ${metadata.dims}`,
            );
        }
        const fingerprint = body.fingerprint ?? body.served_fingerprint;
        if (typeof fingerprint !== "string") {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                "Synapse response omitted the served fingerprint",
            );
        }
        if (fingerprint !== metadata.fingerprint) {
            throw new SynapseEmbeddingError(
                "substitution_rejected",
                `Synapse fingerprint changed from ${metadata.fingerprint} to ${fingerprint}`,
            );
        }
        const epoch = body.table_epoch ?? body.tableEpoch;
        if (typeof epoch !== "number") {
            throw new SynapseEmbeddingError(
                "artifact_invalid",
                "Synapse response omitted the served table epoch",
            );
        }
        if (epoch !== metadata.table_epoch) {
            throw new SynapseEmbeddingError(
                "substitution_rejected",
                `Synapse table epoch changed from ${metadata.table_epoch} to ${epoch}`,
            );
        }
    }

    private logCallFailure(error: unknown, operation: string): void {
        const classified = classifyError(error);
        this.recordFailure(classified);
        if (classified.permanent) this.permanentFailure = true;
        const suffix =
            classified.retryAfterMs === undefined
                ? ""
                : ` retry_after_ms=${classified.retryAfterMs}`;
        log(
            `[magic-context] Synapse ${operation} failed: ${classified.code}${suffix}: ${classified.message}`,
        );
    }

    private recordFailure(error: SynapseEmbeddingError): void {
        this.lastFailureReason = embeddingFailureFor(error);
    }

    private recordSuccess(): void {
        this.lastFailureReason = null;
    }
}

export function _resetSynapseClientForTests(): void {
    sharedClient?.close();
    sharedClient = null;
    sharedClientFile = null;
    sharedClientPromise = null;
}

import { inRootAsyncContext } from "../../../shared/sqlite";
