import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { LocalEmbeddingDtype } from "./embedding-local";
import {
    __resetLocalEmbeddingForTests,
    __setLocalEmbeddingTestHooks,
    LocalEmbeddingProvider,
} from "./embedding-local";
import {
    __resetLocalEmbeddingPoolingForTests,
    __setLocalEmbeddingPoolingForTests,
    preflightLocalEmbeddingPooling,
} from "./local-embedding-pooling";

type TensorLike = { data: ArrayLike<number>; dims: number[] };
type ReferencePipeline = ((text: string, options: { pooling: "none" }) => Promise<TensorLike>) & {
    tokenizer: (
        text: string,
        options: { padding: true; truncation: true },
    ) => {
        attention_mask?: TensorLike;
    };
};

type TransformersModule = {
    pipeline: (
        task: "feature-extraction",
        model: string,
        options: { dtype: string; device?: string },
    ) => Promise<unknown>;
};

const MODEL_CACHE_DIR = resolve(
    import.meta.dir,
    "../../../../../../target/scratch/local-pooling-model-cache",
);
const SENTENCE =
    "A reliable local embedding must use the pooling mode declared by its model configuration.";
const originalHfEndpoint = process.env.HF_ENDPOINT;
const providers: LocalEmbeddingProvider[] = [];

function normalize(vector: number[]): Float32Array {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return Float32Array.from(vector, (value) => value / norm);
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] * left[index];
        rightNorm += right[index] * right[index];
    }
    return dot / Math.sqrt(leftNorm * rightNorm);
}

async function compareToReference(model: string, pooling: "cls" | "mean"): Promise<void> {
    __setLocalEmbeddingPoolingForTests(model, null);
    const metadata = await preflightLocalEmbeddingPooling(model, {
        modelCacheDir: MODEL_CACHE_DIR,
    });
    expect(metadata).toMatchObject({ status: "ready", pooling, normalize: true });

    let referencePipeline: ReferencePipeline | undefined;
    const transformers = (await import(
        "@huggingface/transformers"
    )) as unknown as TransformersModule;
    __setLocalEmbeddingTestHooks({
        host: () => ({ isElectron: false, isBun: false }),
        modelCacheDir: () => MODEL_CACHE_DIR,
        importTransformers: async () =>
            ({
                ...transformers,
                pipeline: async (
                    task: "feature-extraction",
                    modelName: string,
                    options: { dtype: string; device?: string },
                ) => {
                    const pipeline = (await transformers.pipeline(
                        task,
                        modelName,
                        options,
                    )) as ReferencePipeline;
                    referencePipeline = pipeline;
                    return pipeline;
                },
            }) as never,
    });
    const provider = new LocalEmbeddingProvider(
        model,
        512,
        "fp32" as LocalEmbeddingDtype,
        "native",
    );
    providers.push(provider);

    const actual = await provider.embed(SENTENCE);
    expect(actual).not.toBeNull();
    expect(referencePipeline).toBeDefined();
    const raw = await referencePipeline!(SENTENCE, { pooling: "none" });
    expect(raw.dims.length).toBe(3);
    const sequenceLength = raw.dims[1];
    const hiddenSize = raw.dims[2];
    let reference: Float32Array;
    if (pooling === "cls") {
        reference = normalize(Array.from(raw.data).slice(0, hiddenSize));
    } else {
        const encoded = referencePipeline!.tokenizer(SENTENCE, {
            padding: true,
            truncation: true,
        });
        const mask = encoded.attention_mask;
        expect(mask).toBeDefined();
        const maskValues = Array.from(mask!.data).slice(0, sequenceLength);
        const pooled = new Array<number>(hiddenSize).fill(0);
        let attendedTokens = 0;
        for (let token = 0; token < sequenceLength; token += 1) {
            if (Number(maskValues[token]) !== 1) continue;
            attendedTokens += 1;
            for (let dimension = 0; dimension < hiddenSize; dimension += 1) {
                pooled[dimension] += raw.data[token * hiddenSize + dimension];
            }
        }
        reference = normalize(pooled.map((value) => value / attendedTokens));
    }
    expect(cosine(actual!, reference)).toBeGreaterThanOrEqual(0.999);
}

beforeEach(() => {
    mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    __resetLocalEmbeddingForTests();
    __resetLocalEmbeddingPoolingForTests();
});

afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
    __resetLocalEmbeddingForTests();
    __resetLocalEmbeddingPoolingForTests();
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
});

describe("local embeddings match sentence-transformers pooling references", () => {
    test("matches BGE CLS reference vectors from the same ONNX output", async () => {
        await compareToReference("Xenova/bge-small-en-v1.5", "cls");
    }, 180_000);

    test("matches MiniLM mean reference vectors from the same ONNX output", async () => {
        await compareToReference("Xenova/all-MiniLM-L6-v2", "mean");
    }, 180_000);
});
