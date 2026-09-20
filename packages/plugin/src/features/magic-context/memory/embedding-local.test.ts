import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyLocalEmbeddingFailure } from "./embedding-failure";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import {
    __resetLocalEmbeddingForTests,
    __setLocalEmbeddingTestHooks,
    getLocalEmbeddingNativeMemoryStats,
    isNativeRuntimeMissingError,
    type LocalEmbeddingDtype,
    LocalEmbeddingProvider,
    resolveLocalEmbeddingRuntime,
} from "./embedding-local";

afterEach(() => {
    __resetLocalEmbeddingForTests();
});

function nativeBindingLoadError(): Error & { code: string } {
    return Object.assign(
        new Error("ERR_DLOPEN_FAILED: onnxruntime-node/onnxruntime_binding.node failed to load"),
        { code: "ERR_DLOPEN_FAILED" },
    );
}

function missingNativeRuntimeError(): Error & { code: string } {
    return Object.assign(new Error("Cannot find package 'onnxruntime-node'"), {
        code: "ERR_MODULE_NOT_FOUND",
    });
}

function fakeTransformersModule(options?: {
    onPipeline?: (pipelineOptions: { dtype: string; device?: string }) => void;
    env?: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        env: options?.env ?? {},
        LogLevel: { ERROR: "error" },
        pipeline: async (
            _task: string,
            _model: string,
            pipelineOptions: { dtype: string; device?: string },
        ) => {
            options?.onPipeline?.(pipelineOptions);
            return async () => ({ data: new Float32Array([0, 1]), dims: [1, 2] });
        },
    };
}

describe("WASM ONNX runtime module identity", () => {
    test("configures the injected WASM runtime single-threaded before pipeline construction", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-single-thread-"));
        const ortWeb = { env: { wasm: {} as { numThreads?: number } } };
        let threadsAtTransformersImport: number | undefined;
        let threadsAtPipelineConstruction: number | undefined;
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: false, isBun: false, hasNodeFilesystem: false }),
                importWasmOrt: async () => ortWeb,
                importTransformersWasmFallback: async () => {
                    threadsAtTransformersImport = ortWeb.env.wasm.numThreads;
                    return fakeTransformersModule({
                        env: { backends: { onnx: { wasm: ortWeb.env.wasm } } },
                        onPipeline: () => {
                            threadsAtPipelineConstruction = ortWeb.env.wasm.numThreads;
                        },
                    });
                },
                modelCacheDir: () => cacheDir,
            });

            expect(
                await new LocalEmbeddingProvider(
                    "Xenova/all-MiniLM-L6-v2",
                    512,
                    "fp32",
                    "wasm",
                ).initialize(),
            ).toBe(true);
            expect(threadsAtTransformersImport).toBe(1);
            expect(threadsAtPipelineConstruction).toBe(1);
            expect(ortWeb.env.wasm.numThreads).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("imports the canonical resolved URL instead of a host-rewritten bare specifier", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-canonical-"));
        const requestedSpecifiers: string[] = [];
        const canonicalSpecifier =
            "file:///plugin/node_modules/onnxruntime-web/dist/ort.node.min.mjs";
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: false, isBun: false, hasNodeFilesystem: false }),
                resolveWasmOrt: () => canonicalSpecifier,
                importWasmOrt: async (specifier) => {
                    requestedSpecifiers.push(specifier);
                    return { env: { wasm: {} } };
                },
                importTransformersWasmFallback: async () => fakeTransformersModule(),
                modelCacheDir: () => cacheDir,
            });

            expect(
                await new LocalEmbeddingProvider(
                    "Xenova/all-MiniLM-L6-v2",
                    512,
                    "fp32",
                    "wasm",
                ).initialize(),
            ).toBe(true);
            expect(requestedSpecifiers).toEqual([canonicalSpecifier]);
            expect(requestedSpecifiers).not.toContain("onnxruntime-web");
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("falls back to the bare specifier when import.meta.resolve is unavailable", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-resolution-fallback-"));
        const requestedSpecifiers: string[] = [];
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: false, isBun: false, hasNodeFilesystem: false }),
                // Simulate a Node/Bun host where import.meta.resolve is unavailable.
                resolveWasmOrt: () => undefined,
                importWasmOrt: async (specifier) => {
                    requestedSpecifiers.push(specifier);
                    return { env: { wasm: {} } };
                },
                importTransformersWasmFallback: async () => fakeTransformersModule(),
                modelCacheDir: () => cacheDir,
            });

            expect(
                await new LocalEmbeddingProvider(
                    "Xenova/all-MiniLM-L6-v2",
                    512,
                    "fp32",
                    "wasm",
                ).initialize(),
            ).toBe(true);
            expect(requestedSpecifiers).toEqual(["onnxruntime-web"]);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

// Part A of issue #128: classify the PERMANENT "native runtime not installed"
// failure so the provider degrades once (one actionable log line) instead of
// re-importing transformers and re-spamming the cryptic resolver error on every
// embedding. The discriminator must catch the missing-package shapes WITHOUT
// swallowing transient load errors (protobuf/EBUSY) or unrelated failures.
describe("isNativeRuntimeMissingError", () => {
    test("classifies the missing darwin/x64 package binding with Intel-specific context", () => {
        const error = Object.assign(
            new Error("Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'"),
            { code: "ERR_MODULE_NOT_FOUND" },
        );

        expect(classifyLocalEmbeddingFailure(error, { platform: "darwin", arch: "x64" })).toEqual({
            class: "local_binding_missing",
            reason: "onnxruntime-node has no darwin/x64 native binding and the WASM fallback could not complete",
            retryable: false,
        });
    });

    test("Bun resolver: Cannot find package 'onnxruntime-node'", () => {
        expect(
            isNativeRuntimeMissingError(new Error("Cannot find package 'onnxruntime-node'")),
        ).toBe(true);
    });

    test("Node ERR_MODULE_NOT_FOUND targeting onnxruntime-node", () => {
        const err = Object.assign(new Error("Cannot find module 'onnxruntime-node'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("Bun ResolveMessage name on onnxruntime-node", () => {
        const err = Object.assign(new Error("Could not resolve: onnxruntime-node"), {
            name: "ResolveMessage",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("transient protobuf parse failure is NOT classified as missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("Protobuf parsing failed"))).toBe(false);
    });

    test("EBUSY transient is NOT missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("EBUSY: resource busy"))).toBe(false);
    });

    test("unrelated error mentioning neither package nor module is not missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("model file checksum mismatch"))).toBe(false);
    });

    test("a generic 'cannot find module' for some OTHER package is not our runtime", () => {
        // Must mention onnxruntime-node specifically — a different missing module
        // (e.g. a user mis-config) should surface its own error, not be masked as
        // the runtime-missing degrade.
        const err = Object.assign(new Error("Cannot find package 'left-pad'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });

    test("null/undefined/non-error inputs are safe", () => {
        expect(isNativeRuntimeMissingError(null)).toBe(false);
        expect(isNativeRuntimeMissingError(undefined)).toBe(false);
        expect(isNativeRuntimeMissingError("onnxruntime-node")).toBe(false);
    });

    // #7: the package IS installed but its native binary fails to dlopen — e.g.
    // Windows missing the VC++ runtime. The error names the binding file (path
    // contains "onnxruntime") with code ERR_DLOPEN_FAILED, not "onnxruntime-node".
    test("ERR_DLOPEN_FAILED on the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error(
                "\\\\?\\C:\\...\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node " +
                    "is not a valid Win32 application.",
            ),
            { code: "ERR_DLOPEN_FAILED" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("MODULE_NOT_FOUND for the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error("Cannot find module '../bin/napi-v6/win32/x64/onnxruntime_binding.node'"),
            { code: "ERR_MODULE_NOT_FOUND" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("ERR_DLOPEN_FAILED for an UNRELATED native module is not our runtime", () => {
        const err = Object.assign(new Error("some-other-native.node failed to load"), {
            code: "ERR_DLOPEN_FAILED",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });

    test("the known optional Sharp loader failure falls back to WASM", () => {
        expect(
            isNativeRuntimeMissingError(
                new Error('Could not load the "sharp" module using the darwin-arm64 runtime'),
            ),
        ).toBe(true);
    });
});

// Issue #259: the local embedding provider must thread a configured dtype into
// the transformers.js pipeline AND fold it into the model identity so switching
// dtype re-embeds rather than mixing vector spaces. The default (no dtype) must
// produce the byte-identical identity as before this field existed.
describe("LocalEmbeddingProvider dtype threading (#259)", () => {
    test("default constructor (no dtype) keeps the golden identity", () => {
        const provider = new LocalEmbeddingProvider();
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/all-MiniLM-L6-v2",
        });
        expect(provider.modelId).toBe(expected);
    });

    test("explicit fp32 dtype matches the default identity (fp32 is the default)", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 512);
        const fp32 = new LocalEmbeddingProvider(
            "Xenova/all-MiniLM-L6-v2",
            512,
            "fp32" as LocalEmbeddingDtype,
        );
        expect(fp32.modelId).toBe(noDtype.modelId);
    });

    test("a non-default dtype produces a different identity than the default", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/paraphrase-multilingual-MiniLM-L12-v2");
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(noDtype.modelId);
        // And it must equal the identity computed with local_dtype folded in.
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            local_dtype: "q8",
        });
        expect(q8.modelId).toBe(expected);
    });

    test("different non-default dtypes produce different identities", () => {
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        const int8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "int8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(int8.modelId);
    });
});

describe("local embedding runtime selection", () => {
    test("reports loaded provider count and clears it on dispose", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-embedding-memory-stats-"));
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: false, isBun: false }),
                importTransformers: async () => fakeTransformersModule(),
                modelCacheDir: () => cacheDir,
            });
            const provider = new LocalEmbeddingProvider();
            expect(await provider.initialize()).toBe(true);
            expect(getLocalEmbeddingNativeMemoryStats()).toMatchObject({
                loaded: true,
                providerCount: 1,
                models: ["Xenova/all-MiniLM-L6-v2"],
                runtimes: ["native"],
                modelCacheBytes: 0,
            });
            await provider.dispose();
            expect(getLocalEmbeddingNativeMemoryStats().loaded).toBe(false);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("auto selects WASM for Bun before the NAPI teardown fix and native at 1.4.0", () => {
        expect(
            resolveLocalEmbeddingRuntime("auto", {
                isElectron: false,
                isBun: true,
                bunVersion: "1.3.14",
            }),
        ).toBe("wasm");
        expect(
            resolveLocalEmbeddingRuntime("auto", {
                isElectron: false,
                isBun: true,
                bunVersion: "1.4.0",
            }),
        ).toBe("native");
        // This catches a lexical version comparison: 1.10.0 is newer than 1.4.0.
        expect(
            resolveLocalEmbeddingRuntime("auto", {
                isElectron: false,
                isBun: true,
                bunVersion: "1.10.0",
            }),
        ).toBe("native");
    });

    test("auto stays native in Node and explicit native/WASM override the host default", () => {
        const oldBun = { isElectron: false, isBun: true, bunVersion: "1.3.14" };
        expect(resolveLocalEmbeddingRuntime("auto", { isElectron: false, isBun: false })).toBe(
            "native",
        );
        expect(resolveLocalEmbeddingRuntime("native", oldBun)).toBe("native");
        expect(resolveLocalEmbeddingRuntime("wasm", oldBun)).toBe("wasm");
    });

    test("auto preserves Electron's existing early WASM injection path", () => {
        expect(
            resolveLocalEmbeddingRuntime("auto", {
                isElectron: true,
                isBun: false,
            }),
        ).toBe("electron");
    });
});

describe("LocalEmbeddingProvider native-to-WASM fallback", () => {
    test("a vulnerable Bun host injects WASM before transformers and never takes the native fallback", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-bun-wasm-default-"));
        const calls: string[] = [];
        let fallbackImports = 0;
        const pipelineOptions: Array<{ dtype: string; device?: string }> = [];
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({
                    isElectron: false,
                    isBun: true,
                    bunVersion: "1.3.14",
                    hasNodeFilesystem: true,
                }),
                injectWasmOrt: async () => {
                    calls.push("inject");
                    return true;
                },
                importTransformers: async () => {
                    throw new Error(
                        "selected WASM must not evaluate the native Transformers entry",
                    );
                },
                importTransformersNodeWasmFallback: async () => {
                    calls.push("node-wasm");
                    return fakeTransformersModule({
                        env: { useFS: true, useFSCache: true },
                        onPipeline: (options) => pipelineOptions.push(options),
                    });
                },
                importTransformersWasmFallback: async () => {
                    fallbackImports++;
                    throw new Error("Node with fs must not use the browser fallback");
                },
                modelCacheDir: () => cacheDir,
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(calls).toEqual(["inject", "node-wasm"]);
            expect(fallbackImports).toBe(0);
            expect(pipelineOptions).toEqual([{ dtype: "fp32", device: "auto" }]);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("native selection omits a device option and leaves WASM thread settings untouched", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-native-device-default-"));
        const pipelineOptions: Array<{ dtype: string; device?: string }> = [];
        const wasm = { numThreads: 4 };
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: false, isBun: false }),
                importWasmOrt: async () => {
                    throw new Error("native selection must not import onnxruntime-web");
                },
                importTransformers: async () =>
                    fakeTransformersModule({
                        env: { backends: { onnx: { wasm } } },
                        onPipeline: (options) => pipelineOptions.push(options),
                    }),
                modelCacheDir: () => cacheDir,
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(pipelineOptions).toEqual([{ dtype: "fp32" }]);
            expect(wasm.numThreads).toBe(4);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("retries a fully absent native module with WASM", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-absent-native-"));
        const logs: string[] = [];
        let nativeImports = 0;
        let wasmImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                importTransformers: async () => {
                    nativeImports++;
                    throw missingNativeRuntimeError();
                },
                injectWasmOrt: async () => true,
                importTransformersWasmFallback: async () => {
                    wasmImports++;
                    return fakeTransformersModule();
                },
                modelCacheDir: () => cacheDir,
                log: (message) => logs.push(message),
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
            expect(logs).toContainEqual(expect.stringContaining("using onnxruntime-web (WASM)"));
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("uses the Node filesystem WASM twin and produces embeddings after a native binding failure", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-node-fs-wasm-"));
        let browserFallbackImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({
                    isElectron: false,
                    isBun: false,
                    hasNodeFilesystem: true,
                }),
                importTransformers: async () => {
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => true,
                importTransformersNodeWasmFallback: async () =>
                    fakeTransformersModule({
                        env: { useFS: true, useFSCache: true },
                    }),
                importTransformersWasmFallback: async () => {
                    browserFallbackImports++;
                    throw new Error("browser fallback must remain isolated from Node with fs");
                },
                modelCacheDir: () => cacheDir,
            });

            const provider = new LocalEmbeddingProvider();
            expect(await provider.initialize()).toBe(true);
            expect(await provider.embed("fixture text")).toEqual(new Float32Array([0, 1]));
            expect(provider.getLastFailureReason()).toBeNull();
            expect(browserFallbackImports).toBe(0);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("keeps the browser-target fallback for hosts without Node filesystem access", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-browser-wasm-"));
        let browserFallbackImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({
                    isElectron: false,
                    isBun: false,
                    hasNodeFilesystem: false,
                }),
                injectWasmOrt: async () => true,
                importTransformersWasmFallback: async () => {
                    browserFallbackImports++;
                    return fakeTransformersModule();
                },
                importTransformersNodeWasmFallback: async () => {
                    throw new Error("browser-like hosts must not load the Node filesystem twin");
                },
                modelCacheDir: () => cacheDir,
            });

            const provider = new LocalEmbeddingProvider(
                "Xenova/all-MiniLM-L6-v2",
                512,
                "fp32",
                "wasm",
            );
            expect(await provider.initialize()).toBe(true);
            expect(await provider.embed("fixture text")).toEqual(new Float32Array([0, 1]));
            expect(browserFallbackImports).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("classifies a Node WASM bundle without filesystem caching instead of returning an unexplained null", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-node-wasm-no-fs-"));
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({
                    isElectron: false,
                    isBun: false,
                    hasNodeFilesystem: true,
                }),
                importTransformers: async () => {
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => true,
                importTransformersNodeWasmFallback: async () =>
                    fakeTransformersModule({ env: { useFS: false, useFSCache: false } }),
                modelCacheDir: () => cacheDir,
            });

            const provider = new LocalEmbeddingProvider();
            expect(await provider.initialize()).toBe(false);
            expect(provider.getLastFailureReason()).toEqual({
                class: "local_fs_unavailable",
                reason: "the WASM model cache cannot access the Node filesystem",
                retryable: false,
            });
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("retries a classified native load failure once with WASM and keeps that decision process-sticky", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-fallback-"));
        const logs: string[] = [];
        let nativeImports = 0;
        let wasmImports = 0;
        let wasmInjections = 0;
        const pipelineOptions: Array<{ dtype: string; device?: string }> = [];
        try {
            __setLocalEmbeddingTestHooks({
                importTransformers: async () => {
                    nativeImports++;
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => {
                    wasmInjections++;
                    return true;
                },
                importTransformersWasmFallback: async () => {
                    wasmImports++;
                    return fakeTransformersModule({
                        onPipeline: (options) => pipelineOptions.push(options),
                    });
                },
                modelCacheDir: () => cacheDir,
                log: (message) => logs.push(message),
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
            expect(wasmInjections).toBe(1);
            expect(pipelineOptions).toEqual([{ dtype: "fp32", device: "auto" }]);
            expect(logs).toContainEqual(
                expect.stringContaining("WASM inference is slower than native"),
            );
            expect(logs).toContainEqual(expect.stringContaining("openai-compatible"));

            // A second provider must use the selected WASM path directly rather
            // than attempting the known-broken native import again.
            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(2);
            expect(wasmInjections).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("latches disabled and routes to doctor only when native and WASM both fail", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-wasm-both-broken-"));
        const logs: string[] = [];
        let nativeImports = 0;
        let wasmImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                importTransformers: async () => {
                    nativeImports++;
                    throw nativeBindingLoadError();
                },
                injectWasmOrt: async () => true,
                importTransformersWasmFallback: async () => {
                    wasmImports++;
                    throw new Error("Cannot find package 'onnxruntime-web'");
                },
                modelCacheDir: () => cacheDir,
                log: (message) => logs.push(message),
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(false);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
            expect(logs).toContainEqual(
                expect.stringContaining("both the onnxruntime-node native"),
            );
            expect(logs).toContainEqual(
                expect.stringContaining("npx @cortexkit/magic-context@latest doctor"),
            );

            expect(await new LocalEmbeddingProvider().initialize()).toBe(false);
            expect(nativeImports).toBe(1);
            expect(wasmImports).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("explicit WASM preserves Electron's existing Transformers consumer path", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-electron-explicit-wasm-"));
        let regularImports = 0;
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: true, isBun: false, hasNodeFilesystem: true }),
                injectWasmOrt: async () => true,
                importTransformers: async () => {
                    regularImports++;
                    return fakeTransformersModule();
                },
                importTransformersNodeWasmFallback: async () => {
                    throw new Error("Electron must not select the Node fallback twin");
                },
                importTransformersWasmFallback: async () => {
                    throw new Error("Electron must not select the browser fallback twin directly");
                },
                modelCacheDir: () => cacheDir,
            });

            const provider = new LocalEmbeddingProvider(
                "Xenova/all-MiniLM-L6-v2",
                512,
                "fp32",
                "wasm",
            );
            expect(await provider.initialize()).toBe(true);
            expect(regularImports).toBe(1);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("Electron keeps its early WASM injection path without a second fallback initialization", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mc-electron-wasm-"));
        let importsAfterEarlyInjection = 0;
        let fallbackImports = 0;
        let wasmInjections = 0;
        try {
            __setLocalEmbeddingTestHooks({
                host: () => ({ isElectron: true, isBun: false }),
                injectWasmOrt: async () => {
                    wasmInjections++;
                    return true;
                },
                importTransformers: async () => {
                    importsAfterEarlyInjection++;
                    return fakeTransformersModule();
                },
                importTransformersWasmFallback: async () => {
                    fallbackImports++;
                    throw new Error("Electron must not initialize a second WASM fallback");
                },
                modelCacheDir: () => cacheDir,
            });

            expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
            expect(wasmInjections).toBe(1);
            expect(importsAfterEarlyInjection).toBe(1);
            expect(fallbackImports).toBe(0);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
