import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import {
    __resetLocalEmbeddingPoolingForTests,
    __setLocalEmbeddingPoolingForTests,
    getCachedLocalEmbeddingPooling,
    type LocalEmbeddingPoolingMetadata,
    preflightLocalEmbeddingPooling,
} from "./local-embedding-pooling";

const temporaryDirectories: string[] = [];
const originalHfEndpoint = process.env.HF_ENDPOINT;

function tempDirectory(prefix: string): string {
    const path = createTestTempDirFromPath(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

function moduleFiles(modelPath: string, config: Record<string, unknown>): void {
    mkdirSync(join(modelPath, "1_Pooling"), { recursive: true });
    writeFileSync(
        join(modelPath, "modules.json"),
        JSON.stringify([
            { idx: 0, name: "0", path: "", type: "sentence_transformers.models.Transformer" },
            { idx: 1, name: "1", path: "1_Pooling", type: "sentence_transformers.models.Pooling" },
            {
                idx: 2,
                name: "2",
                path: "2_Normalize",
                type: "sentence_transformers.models.Normalize",
            },
        ]),
    );
    writeFileSync(join(modelPath, "1_Pooling", "config.json"), JSON.stringify(config));
}

beforeEach(() => {
    __resetLocalEmbeddingPoolingForTests();
});

afterEach(() => {
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("local sentence-transformers pooling metadata", () => {
    test("reads the pooling module and Normalize module from a local model folder", async () => {
        const root = tempDirectory("mc-local-pooling-folder-");
        const modelPath = join(root, "model");
        mkdirSync(modelPath);
        moduleFiles(modelPath, {
            word_embedding_dimension: 384,
            pooling_mode_cls_token: true,
            pooling_mode_mean_tokens: false,
            pooling_mode_max_tokens: false,
            pooling_mode_lasttoken: false,
        });

        const metadata = await preflightLocalEmbeddingPooling(modelPath, {
            modelCacheDir: join(root, "cache"),
            logger: () => {},
        });

        expect(metadata).toMatchObject({
            status: "ready",
            pooling: "cls",
            normalize: true,
            declared: true,
        });
        expect(getCachedLocalEmbeddingPooling(modelPath)).toMatchObject({ pooling: "cls" });
    });

    test("undeclared local folders retain today's mean pooling and normalization", async () => {
        const root = tempDirectory("mc-local-pooling-undeclared-");
        const modelPath = join(root, "model");
        mkdirSync(modelPath);

        expect(
            await preflightLocalEmbeddingPooling(modelPath, {
                modelCacheDir: join(root, "cache"),
                logger: () => {},
            }),
        ).toMatchObject({
            status: "ready",
            pooling: "mean",
            normalize: true,
            declared: false,
        });
    });

    test("uses the original model's sentence-transformers files for ONNX exports", async () => {
        process.env.HF_ENDPOINT = "https://mirror.example/";
        const root = tempDirectory("mc-local-pooling-remote-");
        const modelCacheDir = join(root, "models");
        const urls: string[] = [];
        __setLocalEmbeddingPoolingForTests("Xenova/bge-small-en-v1.5", null);
        const fetcher = async (url: string): Promise<Response> => {
            urls.push(url);
            if (url.endsWith("/Xenova/bge-small-en-v1.5/resolve/main/modules.json")) {
                return new Response("not found", { status: 404 });
            }
            if (url.endsWith("/Xenova/bge-small-en-v1.5/resolve/main/config.json")) {
                return Response.json({ _name_or_path: "BAAI/bge-small-en-v1.5" });
            }
            if (url.endsWith("/BAAI/bge-small-en-v1.5/resolve/main/modules.json")) {
                return Response.json([
                    {
                        idx: 0,
                        name: "0",
                        path: "",
                        type: "sentence_transformers.models.Transformer",
                    },
                    {
                        idx: 1,
                        name: "1",
                        path: "1_Pooling",
                        type: "sentence_transformers.models.Pooling",
                    },
                    {
                        idx: 2,
                        name: "2",
                        path: "2_Normalize",
                        type: "sentence_transformers.models.Normalize",
                    },
                ]);
            }
            if (url.endsWith("/BAAI/bge-small-en-v1.5/resolve/main/1_Pooling/config.json")) {
                return Response.json({
                    word_embedding_dimension: 384,
                    pooling_mode_cls_token: true,
                    pooling_mode_mean_tokens: false,
                    pooling_mode_max_tokens: false,
                    pooling_mode_lasttoken: false,
                });
            }
            return new Response("not found", { status: 404 });
        };

        const metadata = await preflightLocalEmbeddingPooling("Xenova/bge-small-en-v1.5", {
            modelCacheDir,
            fetcher,
            logger: () => {},
        });
        const digest = createHash("sha256").update("Xenova/bge-small-en-v1.5").digest("hex");
        const cacheRoot = join(modelCacheDir, ".pooling-metadata", digest);
        __resetLocalEmbeddingPoolingForTests();

        expect(metadata).toMatchObject({ status: "ready", pooling: "cls", normalize: true });
        expect(
            getCachedLocalEmbeddingPooling("Xenova/bge-small-en-v1.5", modelCacheDir),
        ).toMatchObject({
            status: "ready",
            pooling: "cls",
        });
        expect(urls.some((url) => url.startsWith("https://mirror.example/"))).toBe(true);
        expect(existsSync(join(cacheRoot, "config.json"))).toBe(true);
        expect(existsSync(join(cacheRoot, "modules.json"))).toBe(true);
        expect(
            existsSync(
                join(cacheRoot, "source", "BAAI", "bge-small-en-v1.5", "1_Pooling", "config.json"),
            ),
        ).toBe(true);
        expect(JSON.parse(readFileSync(join(cacheRoot, "resolution.json"), "utf8"))).toMatchObject({
            pooling: "cls",
        });
    });

    test("offline lookup keeps a cached legacy mean fallback while metadata stays unavailable", async () => {
        const root = tempDirectory("mc-local-pooling-offline-");
        const model = "org/offline-model";
        const modelCacheDir = join(root, "models");
        const logs: string[] = [];
        const legacyIdentity = getEmbeddingProviderIdentity({ provider: "local", model });
        __setLocalEmbeddingPoolingForTests(model, null);
        const result = await preflightLocalEmbeddingPooling(model, {
            modelCacheDir,
            fetcher: async () => {
                throw new Error("network is unavailable");
            },
            logger: (message) => logs.push(message),
        });

        expect(result).toMatchObject({
            status: "unresolved",
            pooling: "mean",
            normalize: true,
            declared: false,
        });
        expect(getCachedLocalEmbeddingPooling(model, modelCacheDir)).toBe(result);
        expect(getEmbeddingProviderIdentity({ provider: "local", model })).toBe(legacyIdentity);
        expect(logs).toEqual([
            expect.stringContaining(
                "network is unavailable; using legacy mean pooling and retrying during a later background bootstrap",
            ),
        ]);
    });

    test("retries unresolved metadata and switches to CLS identity after a successful fetch", async () => {
        const model = "fixture/retry-pooling";
        const modelCacheDir = join(getMagicContextStorageDir(), "models");
        const config = { provider: "local" as const, model };
        const legacyIdentity = getEmbeddingProviderIdentity(config);
        __setLocalEmbeddingPoolingForTests(model, null);

        const offline = await preflightLocalEmbeddingPooling(model, {
            modelCacheDir,
            fetcher: async () => {
                throw new Error("offline once");
            },
            logger: () => {},
        });
        expect(offline.status).toBe("unresolved");
        expect(getEmbeddingProviderIdentity(config)).toBe(legacyIdentity);

        const successfulFetch = async (url: string): Promise<Response> => {
            if (url.endsWith("/modules.json")) {
                return Response.json([
                    {
                        idx: 0,
                        name: "pool",
                        path: "1_Pooling",
                        type: "sentence_transformers.models.Pooling",
                    },
                    {
                        idx: 1,
                        name: "normalize",
                        path: "2_Normalize",
                        type: "sentence_transformers.models.Normalize",
                    },
                ]);
            }
            if (url.endsWith("/1_Pooling/config.json")) {
                return Response.json({
                    pooling_mode_cls_token: true,
                    pooling_mode_mean_tokens: false,
                    pooling_mode_max_tokens: false,
                    pooling_mode_lasttoken: false,
                });
            }
            return new Response("not found", { status: 404 });
        };
        const resolved = await preflightLocalEmbeddingPooling(model, {
            modelCacheDir,
            fetcher: successfulFetch,
            logger: () => {},
        });
        expect(resolved).toMatchObject({ status: "ready", pooling: "cls", normalize: true });
        const clsIdentity = getEmbeddingProviderIdentity(config);
        expect(clsIdentity).not.toBe(legacyIdentity);
        expect(getEmbeddingProviderIdentity(config)).toBe(clsIdentity);
    });

    test("refuses a declared but unsupported pooling mode by name", async () => {
        const root = tempDirectory("mc-local-pooling-unsupported-");
        const modelPath = join(root, "model");
        mkdirSync(modelPath);
        moduleFiles(modelPath, {
            word_embedding_dimension: 384,
            pooling_mode_cls_token: false,
            pooling_mode_mean_tokens: false,
            pooling_mode_max_tokens: true,
            pooling_mode_lasttoken: false,
        });

        const metadata = await preflightLocalEmbeddingPooling(modelPath, {
            modelCacheDir: join(root, "cache"),
            logger: () => {},
        });
        expect(metadata).toMatchObject({ status: "unsupported" });
        expect(metadata?.reason).toContain("pooling_mode_max_tokens");
    });

    test("pooling changes identity only when it changes the legacy mean-normalized vectors", () => {
        const model = "fixture/identity-pooling";
        const config = { provider: "local" as const, model };
        const legacyIdentity = getEmbeddingProviderIdentity(config);
        const meanNormalized: LocalEmbeddingPoolingMetadata = {
            status: "ready",
            pooling: "mean",
            normalize: true,
            declared: true,
            reason: "fixture mean",
        };
        __setLocalEmbeddingPoolingForTests(model, meanNormalized);
        expect(getEmbeddingProviderIdentity(config)).toBe(legacyIdentity);

        __setLocalEmbeddingPoolingForTests(model, {
            status: "ready",
            pooling: "cls",
            normalize: true,
            declared: true,
            reason: "fixture CLS",
        });
        const clsIdentity = getEmbeddingProviderIdentity(config);
        expect(clsIdentity).not.toBe(legacyIdentity);

        __setLocalEmbeddingPoolingForTests(model, {
            status: "ready",
            pooling: "mean",
            normalize: false,
            declared: true,
            reason: "fixture mean without Normalize",
        });
        expect(getEmbeddingProviderIdentity(config)).not.toBe(legacyIdentity);

        const unaffected = { provider: "local" as const, model: "fixture/unaffected" };
        const unaffectedLegacyIdentity = getEmbeddingProviderIdentity(unaffected);
        __setLocalEmbeddingPoolingForTests("fixture/unaffected", meanNormalized);
        expect(getEmbeddingProviderIdentity(unaffected)).toBe(unaffectedLegacyIdentity);
    });
});
