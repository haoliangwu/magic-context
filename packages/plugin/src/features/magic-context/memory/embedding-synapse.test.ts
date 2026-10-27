import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { SubcCallError } from "@cortexkit/subc-client";
import {
    _resetSynapseClientForTests,
    formatSynapseLaneDescriptor,
    getSynapseEmbeddingRowMetadata,
    getSynapseLaneIdentity,
    SYNAPSE_ERROR_VOCABULARY,
    type SynapseClientLike,
    SynapseEmbeddingError,
    SynapseEmbeddingProvider,
    type SynapseMaxTokensSource,
    toSynapseLaneDescriptor,
} from "./embedding-synapse";

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

class MockSynapseClient implements SynapseClientLike {
    readonly requests: Array<{ method: string; params: unknown }> = [];
    private batchAttempts = 0;
    constructor(private readonly batchSize = 2) {}

    async call<Response = unknown>(
        _module: string,
        method: string,
        params?: unknown,
    ): Promise<Response> {
        this.requests.push({ method, params });
        if (method === "models.list") {
            return {
                models: [
                    {
                        model: "gte-modernbert-base-f16",
                        fingerprint: "fp-live",
                        table_epoch: 0,
                        max_tokens: 512,
                        max_tokens_source: "worker_bucket",
                        bucket_ladder: [128, 256, 512],
                        dims: 3,
                        dtype: "f16",
                        device_class: "ane",
                        certified: true,
                        warm_load_cost_hint_ms: 12.5,
                        recommended_batch: this.batchSize,
                        provenance: { source: "fixture" },
                    },
                ],
            } as Response;
        }
        if (method === "embed.query") {
            const request = params as { id: string; text: string };
            const digest = sha256(request.text);
            return {
                fingerprint: "fp-live",
                table_epoch: 0,
                dims: 3,
                payload: {
                    vectors: [
                        {
                            id: request.id,
                            vector: [1, 2, 3],
                            content_sha256: digest,
                            submitted_sha256: digest,
                        },
                    ],
                    truncation_disclosures: [
                        { submitted_tokens: 1, effective_tokens: 1, truncated: false },
                    ],
                },
            } as Response;
        }
        if (method === "embed.batch") {
            this.batchAttempts += 1;
            if (this.batchAttempts === 1) {
                const error = new Error("module is loading") as Error & {
                    code: string;
                    retry_after_ms: number;
                };
                error.code = "model_loading";
                error.retry_after_ms = 0;
                throw error;
            }
            const request = params as {
                items: Array<{ id: string; text: string; content_sha256: string }>;
            };
            return {
                fingerprint: "fp-live",
                table_epoch: 0,
                dims: 3,
                payload: {
                    vectors: request.items.map((item) => ({
                        id: item.id,
                        vector: [1, 2, 3],
                        content_sha256: sha256(item.text),
                        submitted_sha256: sha256(item.text),
                    })),
                    truncation_disclosures: request.items.map(() => ({
                        submitted_tokens: 1,
                        effective_tokens: 1,
                        truncated: false,
                    })),
                },
            } as Response;
        }
        throw new Error(`unexpected method ${method}`);
    }

    close(): void {}
}

afterEach(() => {
    _resetSynapseClientForTests();
});

describe("SynapseEmbeddingProvider", () => {
    it("discovers a certified model and sends the required artifact constraints", async () => {
        const client = new MockSynapseClient();
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.maxInputTokens).toBe(512);
        expect(provider.modelId).toBe(getSynapseLaneIdentity("gte-modernbert-base-f16", "fp-live"));

        const vector = await provider.embed("hello", undefined, "query");
        expect(vector).toEqual(new Float32Array([1, 2, 3]));
        const request = client.requests.find((entry) => entry.method === "embed.query");
        expect(request?.params).not.toHaveProperty("accept_declared");
        expect(request?.params).toMatchObject({
            model: "gte-modernbert-base-f16",
            required_fingerprint: "fp-live",
            required_epoch: 0,
            allow_equivalent: false,
            purpose: "query",
        });
    });

    it("honors the live recommended batch size and retries model loading with retry_after_ms", async () => {
        const client = new MockSynapseClient(1);
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        const vectors = await provider.embedItems(
            [
                { id: "memory:1", text: "one", contentSha256: sha256("one") },
                { id: "memory:2", text: "two", contentSha256: sha256("two") },
            ],
            undefined,
            "query",
        );

        expect(vectors.size).toBe(2);
        const batchRequests = client.requests.filter((entry) => entry.method === "embed.batch");
        expect(batchRequests).toHaveLength(3);
        for (const request of batchRequests)
            expect(request.params).not.toHaveProperty("accept_declared");
        expect(batchRequests[0]?.params).toMatchObject({ purpose: "query" });
        const keys = client.requests
            .filter((entry) => entry.method === "embed.batch")
            .map((entry) => (entry.params as { request_key: string }).request_key);
        expect(keys[0]).toBe(keys[1]);
    });

    it("rejects served fingerprint substitution without adapting", async () => {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(
            _module: string,
            method: string,
            params?: unknown,
        ) => {
            client.requests.push({ method, params });
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-live",
                            table_epoch: 0,
                            max_tokens: 512,
                            max_tokens_source: "worker_bucket",
                            dims: 3,
                        },
                    ],
                } as Response;
            }
            const text = (params as { text: string }).text;
            const digest = sha256(text);
            return {
                fingerprint: "fp-other",
                table_epoch: 0,
                dims: 3,
                payload: {
                    vectors: [
                        {
                            id: "query",
                            vector: [1, 2, 3],
                            content_sha256: digest,
                            submitted_sha256: digest,
                        },
                    ],
                    truncation_disclosures: [
                        { submitted_tokens: 1, effective_tokens: 1, truncated: false },
                    ],
                },
            } as Response;
        };
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });

        expect(await provider.embed("hello")).toBeNull();
        expect(await provider.embed("again")).toBeNull();
    });
});

describe("SYNAPSE certification refusals", () => {
    const contractErrorsSection = `
        StableError::new("deadline_exceeded")
        StableError::new("not_certified")
        StableError::new("substitution_rejected")
        StableError::new("artifact_invalid")
        StableError::new("owned_cuda_unsupported")
        StableError::new("probe_required")
        StableError::new("migration_required")
        StableError::new("module_restarted")
        StableError::new("invalid_request")
        StableError::new("declared_identity_not_accepted")
        StableError::new("remote_identity_drift")
        StableError::new("provider_protocol_violation")
        StableError::new("idempotency_conflict")
        StableError::new("needs_reauth")
        StableError::new("needs_reauth_expired")
        StableError::new("remote_deployment_changed")
        StableError::new("credential_config_invalid")
        StableError::new("op_not_supported_for_remote")
        StableError::new("sentinel_calibration_refused")
    `;

    function parsedContractVocabulary(section: string): string[] {
        return [...section.matchAll(/StableError::new\("([^"]+)"\)/g)].map((match) => match[1]);
    }

    function certificationCallError(detail: string): SubcCallError {
        const error = new SubcCallError(
            "terminal",
            "SYNAPSE refused embedding",
            "certification_refused",
        );
        // Match the additive 0.10.0 getter directly on the managed-call error;
        // this does not rely on an implementation-specific cause chain.
        Object.defineProperty(error, "detail", { value: detail });
        return error;
    }

    function providerForQueryError(error: Error): SynapseEmbeddingProvider {
        const client = new MockSynapseClient();
        client.call = async <Response = unknown>(_module: string, method: string) => {
            if (method === "models.list") {
                return {
                    models: [
                        {
                            model: "gte-modernbert-base-f16",
                            fingerprint: "fp-live",
                            table_epoch: 0,
                            max_tokens: 512,
                            max_tokens_source: "worker_bucket",
                            dims: 3,
                        },
                    ],
                } as Response;
            }
            throw error;
        };
        return new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: "ses-1",
            clientFactory: async () => client,
        });
    }

    it("pins the classification vocabulary to SYNAPSE's drift-guarded Errors section", () => {
        // Pin this snapshot to SYNAPSE's drift-guarded Errors contract so a
        // newly documented reason must be reviewed here. It was mechanically
        // extracted from synapse@c43cd33 crates/synapse-core/src/error_contract.rs
        // because this worktree cannot access the SYNAPSE checkout directly.
        expect(parsedContractVocabulary(contractErrorsSection)).toEqual(SYNAPSE_ERROR_VOCABULARY);
    });

    it.each([
        "not_certified",
        "probe_required",
        "migration_required",
    ])("classifies the retained detail %s as a certification refusal", async (detail) => {
        const provider = providerForQueryError(certificationCallError(detail));

        expect(await provider.embed("hello")).toBeNull();
        const failure = provider.getLastFailureReason();
        expect(failure).toEqual({
            class: "certification_refusal",
            reason: `SYNAPSE certification refused embedding: ${detail}`,
            retryable: false,
        });
    });

    it("keeps a pre-0.10 client shape in the wildcard certification class", async () => {
        const oldClientError = Object.assign(new Error("SYNAPSE refused embedding"), {
            code: "certification_refused",
        });
        const provider = providerForQueryError(oldClientError);

        expect(await provider.embed("hello")).toBeNull();
        expect(provider.getLastFailureReason()).toEqual({
            class: "certification_refusal",
            reason: "SYNAPSE certification refused embedding: unknown reason",
            retryable: false,
        });
    });
});

describe("recommended batch policy", () => {
    it("object-form recommended_batch {rows, token_budget} sets both limits and pages split on the token budget", async () => {
        const calls: number[][] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            max_tokens: 512,
                                            max_tokens_source: "worker_bucket",
                                            recommended_batch: { rows: 3, token_budget: 100 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.map((item) => item.text.length));
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: sha256(item.text),
                                submitted_sha256: sha256(item.text),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        // Forty repeated words per row exceed the 100-token aggregate budget at
        // three rows, so pages split at two even though the row limit is three.
        const text = "token ".repeat(40);
        const items = ["a", "b", "c", "d"].map((id) => ({
            id,
            text,
            contentSha256: createHash("sha256").update(text).digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(4);
        expect(calls.map((page) => page.length)).toEqual([2, 2]);
    });

    it("bare-number recommended_batch still sets the row limit (legacy wire shape)", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            max_tokens: 512,
                                            max_tokens_source: "worker_bucket",
                                            recommended_batch: 2,
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: sha256(item.text),
                                submitted_sha256: sha256(item.text),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const items = ["a", "b", "c"].map((id) => ({
            id,
            text: "hello",
            contentSha256: createHash("sha256").update("hello").digest("hex"),
        }));
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(3);
        expect(calls).toEqual([2, 1]);
    });

    it("single item over the token budget still ships alone", async () => {
        const calls: number[] = [];
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "/tmp/unused",
            projectRoot: "/tmp/p",
            session: "s",
            clientFactory: async () =>
                ({
                    async call(_m: string, method: string, params?: unknown) {
                        if (method === "models.list") {
                            return {
                                result: {
                                    table_epoch: 0,
                                    models: [
                                        {
                                            model_id: "gte-modernbert-base-f16",
                                            fingerprints: ["fp1"],
                                            state: "ready",
                                            max_tokens: 512,
                                            max_tokens_source: "worker_bucket",
                                            recommended_batch: { rows: 8, token_budget: 10 },
                                        },
                                    ],
                                },
                            };
                        }
                        const items = (params as { items: { id: string; text: string }[] }).items;
                        calls.push(items.length);
                        return {
                            items: items.map((item) => ({
                                id: item.id,
                                embedding: [0.5, 0.5],
                                content_sha256: sha256(item.text),
                                submitted_sha256: sha256(item.text),
                                fingerprint: "fp1",
                                table_epoch: 0,
                            })),
                        };
                    },
                    close() {},
                }) as SynapseClientLike,
        });
        const big = "y".repeat(400);
        const items = [
            {
                id: "big1",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
            {
                id: "big2",
                text: big,
                contentSha256: createHash("sha256").update(big).digest("hex"),
            },
        ];
        const vectors = await provider.embedItems(items);
        expect(vectors.size).toBe(2);
        expect(calls).toEqual([1, 1]);
    });
});

type WireItem = { id: string; text: string; content_sha256: string };
type WireRow = {
    id: string;
    vector: number[];
    content_sha256: string;
    submitted_sha256: string;
};

function providerWithWireRows(options: {
    row: (item: WireItem) => WireRow;
    disclosure: (item: WireItem) => Record<string, unknown> | null;
    maxTokens?: number;
    onBatch?: (items: WireItem[]) => void;
}): SynapseEmbeddingProvider {
    const maxTokens = options.maxTokens ?? 512;
    return new SynapseEmbeddingProvider({
        connectionFile: "fixture",
        projectRoot: "/repo",
        session: "wire-contract",
        clientFactory: async () => ({
            async call(_module: string, method: string, params?: unknown) {
                if (method === "models.list") {
                    return {
                        result: {
                            module_generation: 92,
                            table_epoch: 7,
                            models: [
                                {
                                    model_id: "gte-modernbert-base-f16",
                                    fingerprints: ["fp-wire"],
                                    state: "ready",
                                    max_tokens: maxTokens,
                                    max_tokens_source: "worker_bucket",
                                    bucket_ladder: [128, 256, maxTokens],
                                    dims: 3,
                                    dtype: "f16",
                                    device_class: "ane",
                                    certified: true,
                                    warm_load_cost_hint_ms: 8.5,
                                    recommended_batch: { rows: 8, token_budget: 2048 },
                                },
                            ],
                        },
                    };
                }
                if (method !== "embed.batch") throw new Error(`unexpected method ${method}`);
                const items = (params as { items: WireItem[] }).items;
                options.onBatch?.(items);
                return {
                    result: {
                        fingerprint: "fp-wire",
                        table_epoch: 7,
                        dims: 3,
                        payload: {
                            vectors: items.map(options.row),
                            truncation_disclosures: items
                                .map(options.disclosure)
                                .filter(
                                    (value): value is Record<string, unknown> => value !== null,
                                ),
                        },
                    },
                };
            },
            close() {},
        }),
    });
}

describe("Synapse embed row integrity", () => {
    const input = { id: "memory:1", text: "whole input", contentSha256: sha256("whole input") };

    it("accepts an untruncated row whose submitted and content hashes equal the submitted bytes", async () => {
        const provider = providerWithWireRows({
            row: (item) => ({
                id: item.id,
                vector: [1, 2, 3],
                content_sha256: sha256(item.text),
                submitted_sha256: sha256(item.text),
            }),
            disclosure: () => ({ submitted_tokens: 2, effective_tokens: 2, truncated: false }),
        });

        const vector = (await provider.embedItems([input])).get(input.id);
        expect(vector).toEqual(new Float32Array([1, 2, 3]));
        expect(getSynapseEmbeddingRowMetadata(vector!)).toEqual({
            truncated: false,
            submittedSha256: sha256(input.text),
            contentSha256: sha256(input.text),
            effectiveTokens: 2,
        });
    });

    it("accepts a disclosed truncated row and marks it incomplete", async () => {
        const provider = providerWithWireRows({
            row: (item) => ({
                id: item.id,
                vector: [1, 2, 3],
                content_sha256: sha256("whole"),
                submitted_sha256: sha256(item.text),
            }),
            disclosure: () => ({ submitted_tokens: 2, effective_tokens: 1, truncated: true }),
        });

        const vector = (await provider.embedItems([input])).get(input.id);
        expect(vector).toBeDefined();
        expect(getSynapseEmbeddingRowMetadata(vector!)).toMatchObject({
            truncated: true,
            effectiveTokens: 1,
        });
    });

    it("refuses a row whose hashes differ without truncation disclosure", async () => {
        const provider = providerWithWireRows({
            row: (item) => ({
                id: item.id,
                vector: [1, 2, 3],
                content_sha256: sha256("whole"),
                submitted_sha256: sha256(item.text),
            }),
            disclosure: () => null,
        });

        const refusal = provider.embedItems([input]);
        await expect(refusal).rejects.toBeInstanceOf(SynapseEmbeddingError);
        await expect(refusal).rejects.toMatchObject({ code: "schema_violation" });
    });

    it("refuses a truncation disclosure when the hashes match", async () => {
        const provider = providerWithWireRows({
            row: (item) => ({
                id: item.id,
                vector: [1, 2, 3],
                content_sha256: sha256(item.text),
                submitted_sha256: sha256(item.text),
            }),
            disclosure: () => ({ submitted_tokens: 2, effective_tokens: 1, truncated: true }),
        });

        await expect(provider.embedItems([input])).rejects.toMatchObject({
            name: "SynapseEmbeddingError",
            code: "schema_violation",
        });
    });

    it("does not send a row over a 512-token lane ceiling", async () => {
        const sentIds: string[] = [];
        const provider = providerWithWireRows({
            maxTokens: 512,
            onBatch: (items) => sentIds.push(...items.map((item) => item.id)),
            row: (item) => ({
                id: item.id,
                vector: [1, 2, 3],
                content_sha256: sha256(item.text),
                submitted_sha256: sha256(item.text),
            }),
            disclosure: () => ({ submitted_tokens: 1, effective_tokens: 1, truncated: false }),
        });
        const overCeiling = "token ".repeat(10_000);
        const vectors = await provider.embedItems([
            { id: "too-large", text: overCeiling, contentSha256: sha256(overCeiling) },
            { id: "fits", text: "small", contentSha256: sha256("small") },
        ]);

        expect(sentIds).toEqual(["fits"]);
        expect(vectors.has("too-large")).toBe(false);
        expect(vectors.has("fits")).toBe(true);
    });
});

describe("Synapse models.list capability descriptor", () => {
    it.each([
        "runtime_bucket",
        "worker_bucket",
        "catalog",
        "catalog_unloaded",
    ] satisfies SynapseMaxTokensSource[])("parses max_tokens_source=%s", async (source) => {
        const provider = new SynapseEmbeddingProvider({
            connectionFile: "fixture",
            projectRoot: "/repo",
            session: `descriptor:${source}`,
            clientFactory: async () => ({
                async call(_module: string, method: string) {
                    if (method !== "models.list") throw new Error(`unexpected method ${method}`);
                    return {
                        result: {
                            module_generation: 92,
                            table_epoch: 3,
                            models: [
                                {
                                    model_id: "gte-modernbert-base-f16",
                                    fingerprints: ["fp-descriptor"],
                                    state: "ready",
                                    max_tokens: 512,
                                    max_tokens_source: source,
                                    bucket_ladder: [128, 256, 512],
                                    dims: 768,
                                    dtype: "f16",
                                    device_class: "ane",
                                    certified: true,
                                    warm_load_cost_hint_ms: 14.25,
                                    recommended_batch: { rows: 4, token_budget: 1024 },
                                },
                            ],
                        },
                    };
                },
                close() {},
            }),
        });

        expect(await provider.initialize()).toBe(true);
        expect(provider.maxInputTokens).toBe(512);
        expect(provider.metadata).toMatchObject({
            max_tokens: 512,
            max_tokens_source: source,
            bucket_ladder: [128, 256, 512],
            dims: 768,
            dtype: "f16",
            device_class: "ane",
            certified: true,
            warm_load_cost_hint_ms: 14.25,
            recommended_batch: 4,
            recommended_token_budget: 1024,
        });
        const descriptor = toSynapseLaneDescriptor(provider.metadata!);
        expect(descriptor.warm).toBe(source === "runtime_bucket" || source === "worker_bucket");
        expect(formatSynapseLaneDescriptor(descriptor)).toContain(`max_tokens=512 (${source})`);
    });
});
