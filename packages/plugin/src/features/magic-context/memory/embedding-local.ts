import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { shouldEnforcePrivateStoragePermissions } from "../../../shared/storage-permissions";
import { classifyLocalEmbeddingFailure, type EmbeddingFailure } from "./embedding-failure";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";

/** The dtype enum values accepted by @huggingface/transformers' feature-extraction
 *  pipeline (keyof typeof DATA_TYPES in transformers/types/utils/dtypes.d.ts).
 *  Kept as a literal union so the config schema, identity fold, and pipeline
 *  call share one source of truth. See issue #259. */
export type LocalEmbeddingDtype =
    | "auto"
    | "fp32"
    | "fp16"
    | "q8"
    | "int8"
    | "uint8"
    | "q4"
    | "bnb4"
    | "q4f16"
    | "q2"
    | "q2f16"
    | "q1"
    | "q1f16";

export type LocalEmbeddingRuntime = "auto" | "native" | "wasm";
export type ResolvedLocalEmbeddingRuntime = "native" | "wasm" | "electron";

const BUN_NAPI_TEARDOWN_FIX_VERSION = [1, 4, 0] as const;

export type LocalEmbeddingHost = {
    isElectron: boolean;
    isBun: boolean;
    bunVersion?: string;
    /** True only when this host can persist model files through Node's fs API. */
    hasNodeFilesystem?: boolean;
};

function currentLocalEmbeddingHost(): LocalEmbeddingHost {
    const bun = (globalThis as { Bun?: unknown }).Bun;
    const hasProcess = typeof process !== "undefined";
    const bunVersion =
        hasProcess && typeof process.versions?.bun === "string" ? process.versions.bun : undefined;
    return {
        isElectron: hasProcess && Boolean(process.versions?.electron),
        // Check both globals because Bun hosts have exposed each form across releases.
        isBun: Boolean(bun) || Boolean(bunVersion),
        bunVersion,
        // Only the Node-target twin may evaluate real node:fs. Browser-like hosts
        // keep the existing web bundle, while Electron retains its injected path.
        hasNodeFilesystem:
            hasProcess &&
            (typeof process.versions?.node === "string" || typeof bunVersion === "string"),
    };
}

function bunHasNapiTeardownFix(version: string | undefined): boolean {
    const match = version?.match(
        /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    if (!match || match[4]) return false;
    const parsed = [Number(match[1]), Number(match[2]), Number(match[3])];
    return parsed.some((part) => !Number.isSafeInteger(part))
        ? false
        : parsed[0] > BUN_NAPI_TEARDOWN_FIX_VERSION[0] ||
              (parsed[0] === BUN_NAPI_TEARDOWN_FIX_VERSION[0] &&
                  (parsed[1] > BUN_NAPI_TEARDOWN_FIX_VERSION[1] ||
                      (parsed[1] === BUN_NAPI_TEARDOWN_FIX_VERSION[1] &&
                          parsed[2] >= BUN_NAPI_TEARDOWN_FIX_VERSION[2])));
}

/** Resolves the local ONNX runtime without loading either implementation. */
export function resolveLocalEmbeddingRuntime(
    preference: LocalEmbeddingRuntime = "auto",
    host: LocalEmbeddingHost = currentLocalEmbeddingHost(),
): ResolvedLocalEmbeddingRuntime {
    if (preference === "native" || preference === "wasm") return preference;
    if (host.isElectron) return "electron";
    if (host.isBun && !bunHasNapiTeardownFix(host.bunVersion)) return "wasm";
    return "native";
}

/**
 * Cross-process mutex for embedding-model load. When two OpenCode processes
 * spawn simultaneously (typical Desktop sidecar + TUI + dashboard setup), they
 * can both call onnxruntime-node's `InferenceSession::LoadModel` on the same
 * cached `.onnx` file at the same wall-clock time. Older onnxruntime-node
 * builds (<=1.21.0 / native lib 1.14.0) could double-free an internal
 * `IoBinding` during cleanup when this happened, producing SIGBUS/SIGTRAP
 * crashes inside the worker thread and silently killing the TUI.
 *
 * See https://github.com/cortexkit/magic-context/issues/21.
 *
 * Transformers v4 / onnxruntime-node 1.24.x ships a much newer native library
 * and is expected to handle this, but we add a belt-and-suspenders file lock
 * so two processes never call `createPipeline()` at the exact same instant.
 *
 * Contract:
 *   - Uses `open(path, "wx")` — atomic-create with exclusive flag on POSIX,
 *     and the equivalent on Windows (ERROR_FILE_EXISTS).
 *   - Writes our PID + timestamp to the lock file for diagnostics.
 *   - If the lock is held by another process, polls every 150ms.
 *   - Treats a lock file older than `STALE_LOCK_MS` as stale (crashed holder)
 *     and takes it over.
 *   - If we cannot acquire the lock within `MAX_LOCK_WAIT_MS`, we log a
 *     warning and proceed without the lock rather than blocking embedding
 *     forever. Model load failures in this case are caught by the retry loop.
 */
const LOCK_POLL_MS = 150;
const STALE_LOCK_MS = 3 * 60_000; // 3 minutes — model loads are typically <30s
const MAX_LOCK_WAIT_MS = 5 * 60_000; // 5 minutes

async function acquireModelLoadLock(lockPath: string): Promise<() => Promise<void>> {
    const waitStart = Date.now();
    while (true) {
        try {
            const handle = await open(lockPath, "wx");
            // Best-effort write of PID + timestamp for diagnostics.
            try {
                await handle.writeFile(`pid=${process.pid} started=${Date.now()}\n`);
            } catch {
                /* non-fatal */
            }
            await handle.close();
            return async () => {
                try {
                    await unlink(lockPath);
                } catch {
                    /* already gone / race — ignore */
                }
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // On Windows, Node can surface EEXIST as EPERM for this case.
            if (code !== "EEXIST" && code !== "EPERM") {
                throw error;
            }
            // Lock exists — check if it's stale.
            try {
                const info = await stat(lockPath);
                if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
                    log(
                        `[magic-context] embedding-load lock stale (>${STALE_LOCK_MS}ms), taking over`,
                    );
                    try {
                        await unlink(lockPath);
                    } catch {
                        /* another process may have cleaned it up — retry acquire */
                    }
                    continue;
                }
            } catch {
                // Lock disappeared between create-fail and stat — retry acquire.
                continue;
            }
            if (Date.now() - waitStart > MAX_LOCK_WAIT_MS) {
                // Do NOT proceed without the lock. A genuinely stuck holder is
                // already reclaimed by the STALE_LOCK_MS takeover above (the
                // lock's heartbeat stops if its process died), so reaching this
                // branch means a LEGITIMATE slow model load is still running in
                // another process — exactly when an unsynchronized
                // createPipeline() here would reintroduce the onnxruntime
                // double-free native crash (issue #21) the lock exists to
                // prevent. Fail this init attempt instead; the caller catches,
                // sets pipeline=null, and the lazy fallback retries on a later
                // pass once the holder finishes.
                throw new Error(
                    `[magic-context] embedding-load lock wait exceeded ${MAX_LOCK_WAIT_MS}ms; another process is still loading the model. Skipping this init attempt to avoid an unsynchronized native load.`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        }
    }
}

// Touch the lock file periodically so a long-running model load doesn't get
// misdetected as stale by another waiting process.
function startLockHeartbeat(lockPath: string): () => void {
    const HEARTBEAT_MS = Math.floor(STALE_LOCK_MS / 3);
    const timer = setInterval(() => {
        // writeFile with fresh content updates mtime; any error is non-fatal.
        writeFile(lockPath, `pid=${process.pid} alive=${Date.now()}\n`).catch(() => {});
    }, HEARTBEAT_MS);
    // Don't keep the event loop alive solely for the heartbeat.
    timer.unref?.();
    return () => clearInterval(timer);
}

type TransformersModule = Record<string, unknown>;

type WasmOrtModule = {
    env?: {
        wasm?: {
            numThreads?: number;
            wasmPaths?: string | Record<string, string>;
        };
    };
    default?: unknown;
};

type ImportWasmOrtModule = (specifier: string) => Promise<WasmOrtModule>;

type LocalEmbeddingRuntimeMode = "native" | "wasm" | "disabled";

type LocalEmbeddingTestHooks = {
    host?: () => LocalEmbeddingHost;
    injectWasmOrt?: () => Promise<boolean>;
    resolveWasmOrt?: () => string | undefined;
    importWasmOrt?: ImportWasmOrtModule;
    importTransformers?: () => Promise<TransformersModule>;
    importTransformersWasmFallback?: () => Promise<TransformersModule>;
    importTransformersNodeWasmFallback?: () => Promise<TransformersModule>;
    modelCacheDir?: () => string;
    log?: (message: string, data?: unknown) => void;
};

const ONNX_RUNTIME_WEB_SPECIFIER = "onnxruntime-web";

let localEmbeddingRuntimeMode: LocalEmbeddingRuntimeMode = "native";
let localEmbeddingProcessFailure: EmbeddingFailure | null = null;
let wasmRuntimeInjected = false;
let localEmbeddingHostForRuntime = currentLocalEmbeddingHost;
let resolveWasmOrtForRuntime = (): string | undefined => {
    try {
        return typeof import.meta.resolve === "function"
            ? import.meta.resolve(ONNX_RUNTIME_WEB_SPECIFIER)
            : undefined;
    } catch {
        return undefined;
    }
};
const importWasmOrtModule = async (specifier: string): Promise<WasmOrtModule> =>
    (await import(specifier)) as WasmOrtModule;
let importWasmOrtModuleForRuntime: ImportWasmOrtModule = importWasmOrtModule;
let importWasmOrtForRuntime = async (): Promise<{
    module: WasmOrtModule;
    entryPath: string;
}> => {
    const { createRequire: createRequireFn } = await import("node:module");
    const requireFn = createRequireFn(import.meta.url);
    const ortEntry = requireFn.resolve(ONNX_RUNTIME_WEB_SPECIFIER);

    // Resolve before importing because a host loader may rewrite a bare
    // specifier with a reload tag; a second query-free import of the same file
    // would otherwise create another identity and register the CPU backend twice.
    const ortSpecifier = resolveWasmOrtForRuntime() ?? ONNX_RUNTIME_WEB_SPECIFIER;
    return {
        module: await importWasmOrtModuleForRuntime(ortSpecifier),
        entryPath: ortEntry,
    };
};
let importTransformersForRuntime = async (): Promise<TransformersModule> => {
    // Keep transformers in a lazy split chunk: the host can load the plugin and
    // use remote embeddings without evaluating the optional native accelerator.
    return (await import("@huggingface/transformers")) as TransformersModule;
};
let importTransformersWasmFallbackForRuntime = async (): Promise<TransformersModule> => {
    // The browser-condition sibling remains the compatibility path for Electron
    // and hosts without Node filesystem access.
    const webEntry = new URL("./transformers-web.js", import.meta.url).href;
    return (await import(webEntry)) as TransformersModule;
};
let importTransformersNodeWasmFallbackForRuntime = async (): Promise<TransformersModule> => {
    // This sibling resolves Transformers.js's Node source (real node:fs) while
    // aliasing optional native addons away from their platform loaders.
    const nodeWasmEntry = new URL("./transformers-node-wasm.js", import.meta.url).href;
    return (await import(nodeWasmEntry)) as TransformersModule;
};
let modelCacheDirForRuntime = () => join(getMagicContextStorageDir(), "models");
let logForRuntime: (message: string, data?: unknown) => void = log;
let injectWasmOrtForRuntime: () => Promise<boolean> = injectWasmOrt;

interface LoadedLocalEmbeddingRuntime {
    model: string;
    runtime: "native" | "wasm";
    rssDeltaAtLoad: number;
    externalDeltaAtLoad: number;
    arrayBuffersDeltaAtLoad: number;
}

const loadedLocalEmbeddingRuntimes = new Map<number, LoadedLocalEmbeddingRuntime>();
let nextLocalEmbeddingRuntimeId = 1;

export interface LocalEmbeddingNativeMemoryStats {
    loaded: boolean;
    providerCount: number;
    models: string[];
    runtimes: Array<"native" | "wasm">;
    modelCacheBytes: number | null;
    rssDeltaAtLoad: number;
    externalDeltaAtLoad: number;
    arrayBuffersDeltaAtLoad: number;
}

function directoryBytes(path: string): number | null {
    let total = 0;
    try {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const entryPath = join(path, entry.name);
            if (entry.isDirectory()) {
                const childBytes = directoryBytes(entryPath);
                if (childBytes === null) return null;
                total += childBytes;
            } else if (entry.isFile()) {
                total += statSync(entryPath).size;
            }
        }
        return total;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
    }
}

/** ONNX does not expose arena residency; report loaded runtimes and serialized model bytes. */
export function getLocalEmbeddingNativeMemoryStats(): LocalEmbeddingNativeMemoryStats {
    const loaded = [...loadedLocalEmbeddingRuntimes.values()];
    return {
        loaded: loaded.length > 0,
        providerCount: loaded.length,
        models: [...new Set(loaded.map((entry) => entry.model))].sort(),
        runtimes: [...new Set(loaded.map((entry) => entry.runtime))].sort(),
        modelCacheBytes: loaded.length > 0 ? directoryBytes(modelCacheDirForRuntime()) : 0,
        rssDeltaAtLoad: loaded.reduce((sum, entry) => sum + entry.rssDeltaAtLoad, 0),
        externalDeltaAtLoad: loaded.reduce((sum, entry) => sum + entry.externalDeltaAtLoad, 0),
        arrayBuffersDeltaAtLoad: loaded.reduce(
            (sum, entry) => sum + entry.arrayBuffersDeltaAtLoad,
            0,
        ),
    };
}

/** Test-only seams keep native-loader failures reproducible without loading a real addon. */
export function __setLocalEmbeddingTestHooks(hooks: LocalEmbeddingTestHooks): void {
    localEmbeddingHostForRuntime = hooks.host ?? (() => ({ isElectron: false, isBun: false }));
    injectWasmOrtForRuntime = hooks.injectWasmOrt ?? injectWasmOrt;
    resolveWasmOrtForRuntime = hooks.resolveWasmOrt ?? resolveWasmOrtForRuntimeDefault;
    importWasmOrtModuleForRuntime = hooks.importWasmOrt ?? importWasmOrtModuleForRuntimeDefault;
    importTransformersForRuntime = hooks.importTransformers ?? importTransformersForRuntimeDefault;
    importTransformersWasmFallbackForRuntime =
        hooks.importTransformersWasmFallback ?? importTransformersWasmFallbackForRuntimeDefault;
    importTransformersNodeWasmFallbackForRuntime =
        hooks.importTransformersNodeWasmFallback ??
        importTransformersNodeWasmFallbackForRuntimeDefault;
    modelCacheDirForRuntime =
        hooks.modelCacheDir ?? (() => join(getMagicContextStorageDir(), "models"));
    logForRuntime = hooks.log ?? log;
}

/** Reset process-global runtime decisions between isolated provider tests. */
export function __resetLocalEmbeddingForTests(): void {
    localEmbeddingRuntimeMode = "native";
    localEmbeddingProcessFailure = null;
    wasmRuntimeInjected = false;
    localEmbeddingHostForRuntime = currentLocalEmbeddingHost;
    resolveWasmOrtForRuntime = resolveWasmOrtForRuntimeDefault;
    importWasmOrtModuleForRuntime = importWasmOrtModuleForRuntimeDefault;
    importWasmOrtForRuntime = importWasmOrtForRuntimeDefault;
    importTransformersForRuntime = importTransformersForRuntimeDefault;
    importTransformersWasmFallbackForRuntime = importTransformersWasmFallbackForRuntimeDefault;
    importTransformersNodeWasmFallbackForRuntime =
        importTransformersNodeWasmFallbackForRuntimeDefault;
    modelCacheDirForRuntime = () => join(getMagicContextStorageDir(), "models");
    logForRuntime = log;
    injectWasmOrtForRuntime = injectWasmOrt;
    loadedLocalEmbeddingRuntimes.clear();
}

const resolveWasmOrtForRuntimeDefault = resolveWasmOrtForRuntime;
const importWasmOrtModuleForRuntimeDefault = importWasmOrtModuleForRuntime;
const importWasmOrtForRuntimeDefault = importWasmOrtForRuntime;
const importTransformersForRuntimeDefault = importTransformersForRuntime;
const importTransformersWasmFallbackForRuntimeDefault = importTransformersWasmFallbackForRuntime;
const importTransformersNodeWasmFallbackForRuntimeDefault =
    importTransformersNodeWasmFallbackForRuntime;

/**
 * Inject the WASM ONNX runtime before transformers evaluates its web bundle.
 * This path is used by Electron before a native attempt and by the fallback
 * after a broken native binding is detected.
 */
async function ensureWasmOrtInjected(): Promise<boolean> {
    if (wasmRuntimeInjected) return true;
    if (!(await injectWasmOrtForRuntime())) return false;
    wasmRuntimeInjected = true;
    return true;
}

async function injectWasmOrt(): Promise<boolean> {
    if (wasmRuntimeInjected) return true;

    try {
        const { module: ortWeb, entryPath } = await importWasmOrtForRuntime();

        if (ortWeb.env?.wasm) {
            // ORT's WASM worker threads can spin between runs and cannot currently
            // be terminated. A single thread keeps the host event loop idle.
            ortWeb.env.wasm.numThreads = 1;

            // Prefer package-local assets so first use works offline instead of
            // requiring the default CDN path.
            ortWeb.env.wasm.wasmPaths = `${pathToFileURL(dirname(entryPath)).href}/`;
        }

        (globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ortWeb;
        wasmRuntimeInjected = true;
        return true;
    } catch (error) {
        log(
            "[magic-context] failed to inject onnxruntime-web:",
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

function likelyMuslHint(): string {
    if (process.platform !== "linux" || typeof process.report?.getReport !== "function") return "";
    try {
        const report = process.report.getReport() as {
            header?: { glibcVersionRuntime?: unknown };
        };
        return typeof report.header?.glibcVersionRuntime === "string"
            ? ""
            : " Linux process report has no glibc runtime version (musl likely).";
    } catch {
        return "";
    }
}

function localEmbeddingRuntimeIsDisabled(): boolean {
    return localEmbeddingRuntimeMode === "disabled";
}

class LocalEmbeddingFallbackError extends Error {
    readonly nativeError: unknown;

    constructor(nativeError: unknown, wasmError: unknown) {
        super("the native local embedding runtime and its WASM fallback both failed", {
            cause: wasmError,
        });
        this.name = "LocalEmbeddingFallbackError";
        this.nativeError = nativeError;
    }
}

class LocalEmbeddingFsUnavailableError extends Error {
    readonly code = "MC_EMBEDDING_FS_UNAVAILABLE";

    constructor() {
        super("MC_EMBEDDING_FS_UNAVAILABLE: Node WASM bundle has no filesystem cache");
        this.name = "LocalEmbeddingFsUnavailableError";
    }
}

async function importWasmTransformersForHost(): Promise<TransformersModule> {
    const host = localEmbeddingHostForRuntime();
    if (host.isElectron) {
        return importTransformersForRuntime();
    }
    return host.hasNodeFilesystem
        ? importTransformersNodeWasmFallbackForRuntime()
        : importTransformersWasmFallbackForRuntime();
}

function disableLocalEmbeddingsAfterRuntimeFailure(detail: string): void {
    localEmbeddingRuntimeMode = "disabled";
    logForRuntime(
        "[magic-context] local embeddings are disabled because both the onnxruntime-node native " +
            "binding and the onnxruntime-web (WASM) fallback failed to load. " +
            `Native failure: ${detail}. Run \`npx @cortexkit/magic-context@latest doctor\` for diagnostics; ` +
            "reinstalling repairs missing package files but cannot add a native binding that upstream does not ship. " +
            "Alternatively, configure an `openai-compatible` embedding HTTP endpoint. Existing memories are unaffected.",
    );
}

async function loadTransformersForLocalEmbedding(
    runtimePreference: LocalEmbeddingRuntime,
): Promise<{
    module: TransformersModule;
    usesWasm: boolean;
}> {
    if (localEmbeddingRuntimeMode === "disabled") {
        throw new Error("local embedding runtime is disabled");
    }

    const resolvedRuntime = resolveLocalEmbeddingRuntime(
        runtimePreference,
        localEmbeddingHostForRuntime(),
    );
    if (resolvedRuntime === "wasm") {
        if (!(await ensureWasmOrtInjected())) {
            disableLocalEmbeddingsAfterRuntimeFailure("the selected WASM runtime is unavailable");
            throw new Error("onnxruntime-web failed to load");
        }
        return { module: await importWasmTransformersForHost(), usesWasm: true };
    }

    if (localEmbeddingRuntimeMode === "wasm") {
        if (!(await ensureWasmOrtInjected())) {
            disableLocalEmbeddingsAfterRuntimeFailure(
                "the previously selected WASM runtime is unavailable",
            );
            throw new Error("onnxruntime-web failed to load");
        }
        try {
            return { module: await importWasmTransformersForHost(), usesWasm: true };
        } catch (wasmError) {
            disableLocalEmbeddingsAfterRuntimeFailure(
                "the previously selected WASM runtime failed to load",
            );
            throw wasmError;
        }
    }

    const electron = resolvedRuntime === "electron";
    if (electron) {
        const wasInjected = wasmRuntimeInjected;
        if (await ensureWasmOrtInjected()) {
            if (!wasInjected) {
                logForRuntime(
                    "[magic-context] Electron detected — using onnxruntime-web (WASM) for embeddings (bypasses onnxruntime-node native load)",
                );
            }
            // Electron keeps its existing Transformers consumer path because the
            // injected onnxruntime-web global must exist before Transformers resolves.
            return { module: await importTransformersForRuntime(), usesWasm: true };
        }
    }

    try {
        return { module: await importTransformersForRuntime(), usesWasm: false };
    } catch (nativeError) {
        if (!isNativeRuntimeMissingError(nativeError) || electron) {
            throw nativeError;
        }

        if (!(await ensureWasmOrtInjected())) {
            disableLocalEmbeddingsAfterRuntimeFailure(
                nativeError instanceof Error ? nativeError.message : String(nativeError),
            );
            throw nativeError;
        }

        // Once native has failed, all later providers must choose the same WASM
        // path instead of repeating the broken native import while this retry loads.
        localEmbeddingRuntimeMode = "wasm";
        try {
            const module = await importWasmTransformersForHost();
            logForRuntime(
                "[magic-context] onnxruntime-node failed to load; using onnxruntime-web (WASM) for local embeddings. " +
                    "WASM inference is slower than native; a remote `openai-compatible` provider may be faster." +
                    likelyMuslHint(),
            );
            return { module, usesWasm: true };
        } catch (wasmError) {
            disableLocalEmbeddingsAfterRuntimeFailure(
                nativeError instanceof Error ? nativeError.message : String(nativeError),
            );
            throw new LocalEmbeddingFallbackError(nativeError, wasmError);
        }
    }
}

type EmbeddingPipelineResult = {
    data: ArrayLike<number> | ArrayLike<number>[];
    dims?: number[];
};

type EmbeddingPipeline = {
    (
        input: string | string[],
        options: { pooling: "mean"; normalize: true },
    ): Promise<EmbeddingPipelineResult>;
    dispose?: () => Promise<void> | void;
};

type CreateEmbeddingPipeline = (
    task: "feature-extraction",
    model: string,
    options: { dtype: string; device?: string },
) => Promise<EmbeddingPipeline>;

/** The dtype the local provider passes to the transformers.js pipeline when the
 *  user does not configure one. This MUST stay "fp32" to preserve today's
 *  behavior exactly — existing installs see zero change on upgrade, and the
 *  default identity string stays byte-identical (local_dtype is only folded
 *  into identity when the user actually sets it). See issue #259. */
const DEFAULT_LOCAL_DTYPE: LocalEmbeddingDtype = "fp32";

/**
 * Temporarily redirects console.warn and console.error to the file logger
 * so that @huggingface/transformers and ONNX runtime never leak to the TUI.
 */
async function withQuietConsole<T>(fn: () => Promise<T>): Promise<T> {
    const origWarn = console.warn;
    const origError = console.error;
    const redirect = (...args: unknown[]) => {
        const message = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        log(`[transformers] ${message}`);
    };
    console.warn = redirect;
    console.error = redirect;
    try {
        return await fn();
    } finally {
        console.warn = origWarn;
        console.error = origError;
    }
}

/**
 * Recognizes the permanent native-runtime load failure. A missing package or a
 * broken platform binding is environmental rather than transient, and triggers
 * exactly one WASM retry before the process is permanently disabled.
 */

export function isNativeRuntimeMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;

    // onnxruntime-node IS installed but its native binary fails to LOAD — e.g.
    // Windows missing the VC++ runtime throws ERR_DLOPEN_FAILED on the
    // `onnxruntime_binding.node` file (whose path contains "onnxruntime", not
    // necessarily the literal "onnxruntime-node"). A failed postinstall can also
    // surface as MODULE_NOT_FOUND for `onnxruntime_binding.node`. Both are
    // environmental and permanent, same as the missing-package case: latch and
    // degrade once instead of re-spamming the load error on every embedding.
    if (code === "ERR_DLOPEN_FAILED" && lower.includes("onnxruntime")) {
        return true;
    }

    // transformers' Node entry also loads optional Sharp bindings at module
    // initialization. Treat its known loader failure like an absent ONNX addon:
    // the bundled web entry does not need either native dependency.
    if (lower.includes('could not load the "sharp" module')) return true;

    const mentionsNativeRuntime =
        lower.includes("onnxruntime-node") || lower.includes("onnxruntime_binding");
    if (!mentionsNativeRuntime) return false;
    return (
        code === "ERR_MODULE_NOT_FOUND" ||
        name === "ResolveMessage" ||
        lower.includes("cannot find package") ||
        lower.includes("cannot find module") ||
        lower.includes("err_module_not_found")
    );
}

/**
 * Recognizes transient ONNX/transformers load failures that should be retried
 * rather than surfaced to the user. Seen in live logs when multiple plugin
 * processes initialize the embedding pipeline within the same window. The
 * on-disk model file is intact; the failure is ephemeral and resolves on retry.
 */
function isTransientLoadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
        lower.includes("protobuf parsing failed") ||
        lower.includes("unable to get model file path or buffer") ||
        lower.includes("ebusy") ||
        lower.includes("resource busy") ||
        lower.includes("resource temporarily unavailable")
    );
}

function isArrayLikeNumber(value: unknown): value is ArrayLike<number> {
    if (typeof value !== "object" || value === null || !("length" in value)) {
        return false;
    }
    const arr = value as { length: unknown; [key: number]: unknown };
    if (typeof arr.length !== "number") {
        return false;
    }
    // Verify a sample element is numeric (or array is empty)
    return arr.length === 0 || typeof arr[0] === "number";
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
    // Intentional: defensive copy for Float32Array inputs prevents mutation of pipeline output.
    // The one-time copy cost is negligible compared to inference cost.
    return values instanceof Float32Array
        ? new Float32Array(values)
        : Float32Array.from(Array.from(values));
}

function extractBatchEmbeddings(
    result: EmbeddingPipelineResult,
    expectedCount: number,
): (Float32Array | null)[] {
    const { data } = result;

    if (
        Array.isArray(data) &&
        data.length === expectedCount &&
        data.every((entry) => typeof entry !== "number" && isArrayLikeNumber(entry))
    ) {
        return data.map((entry) => toFloat32Array(entry));
    }

    if (!isArrayLikeNumber(data)) {
        log("[magic-context] embedding batch returned unexpected data shape");
        return Array.from({ length: expectedCount }, () => null);
    }

    const flatData = toFloat32Array(data);
    const dimension = result.dims?.at(-1) ?? flatData.length / expectedCount;

    if (
        !Number.isInteger(dimension) ||
        dimension <= 0 ||
        flatData.length !== expectedCount * dimension
    ) {
        log("[magic-context] embedding batch returned invalid dimensions");
        return Array.from({ length: expectedCount }, () => null);
    }

    const embeddings: Float32Array[] = [];
    for (let index = 0; index < expectedCount; index++) {
        embeddings.push(flatData.slice(index * dimension, (index + 1) * dimension));
    }

    return embeddings;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;

    private readonly memoryStatsId = nextLocalEmbeddingRuntimeId++;
    private readonly model: string;
    private readonly dtype: LocalEmbeddingDtype;
    private readonly runtimePreference: LocalEmbeddingRuntime;
    private pipeline: EmbeddingPipeline | null = null;
    private initPromise: Promise<void> | null = null;
    private lastFailureReason: EmbeddingFailure | null = null;
    private usesWasm = false;
    private inFlight = 0;
    private disposing = false;
    private disposePromise: Promise<void> | null = null;
    private readonly inFlightWaiters: Array<() => void> = [];

    constructor(
        model = DEFAULT_LOCAL_EMBEDDING_MODEL,
        maxInputTokens = 512,
        dtype: LocalEmbeddingDtype = DEFAULT_LOCAL_DTYPE,
        runtimePreference: LocalEmbeddingRuntime = "auto",
    ) {
        this.model = model;
        this.maxInputTokens = maxInputTokens;
        this.dtype = dtype || DEFAULT_LOCAL_DTYPE;
        this.runtimePreference = runtimePreference;
        this.modelId = getEmbeddingProviderIdentity({
            provider: "local",
            model,
            local_runtime: runtimePreference,
            // Only fold non-default dtype into identity so the default config
            // produces the byte-identical identity string as before this field
            // existed (no forced re-embed on upgrade). See issue #259.
            ...(dtype && dtype !== DEFAULT_LOCAL_DTYPE ? { local_dtype: dtype } : {}),
        });
    }

    async initialize(): Promise<boolean> {
        if (this.disposing) {
            return false;
        }

        if (this.pipeline) {
            return true;
        }

        // A process that proved both runtimes unusable must not retry imports on
        // every embedding request. A successful WASM choice remains reusable.
        if (localEmbeddingRuntimeMode === "disabled") {
            this.lastFailureReason =
                localEmbeddingProcessFailure ??
                classifyLocalEmbeddingFailure(new Error("local embedding runtime is disabled"));
            return false;
        }

        if (this.initPromise) {
            await this.initPromise;
            return this.pipeline !== null;
        }

        const memoryBeforeLoad = process.memoryUsage();
        this.initPromise = (async () => {
            try {
                if (this.disposing) {
                    return;
                }

                const { module: transformersModule, usesWasm } =
                    await loadTransformersForLocalEmbedding(this.runtimePreference);
                this.usesWasm = usesWasm;
                const env = transformersModule.env as {
                    logLevel?: unknown;
                    cacheDir?: string;
                    useFS?: boolean;
                    useFSCache?: boolean;
                };
                const LogLevel = transformersModule.LogLevel as Record<string, unknown> | undefined;
                if (LogLevel && "ERROR" in LogLevel) {
                    env.logLevel = LogLevel.ERROR;
                }

                const host = localEmbeddingHostForRuntime();
                if (
                    usesWasm &&
                    host.hasNodeFilesystem &&
                    !host.isElectron &&
                    (env.useFS !== true || env.useFSCache !== true)
                ) {
                    throw new LocalEmbeddingFsUnavailableError();
                }

                // Set a stable model cache directory outside of node_modules.
                // On Windows, the default .cache inside the npm cached install
                // (e.g. ~\.cache\opencode\packages\...\node_modules\@huggingface\transformers\.cache)
                // can be inaccessible or non-writable, causing "Unable to get model file path
                // or buffer" failures. Using our own storage dir survives plugin updates too.
                const modelCacheDir = modelCacheDirForRuntime();
                try {
                    // Keep the cache owner-only by default because it shares the
                    // storage tree with memories/history. Trusted-group deployments
                    // manage this directory externally, so skip both mode creation
                    // and chmod rather than attempting a different permission change.
                    if (shouldEnforcePrivateStoragePermissions()) {
                        mkdirSync(modelCacheDir, { recursive: true, mode: 0o700 });
                        if (process.platform !== "win32") {
                            try {
                                chmodSync(modelCacheDir, 0o700);
                            } catch {
                                // Non-fatal — leave default perms if chmod is rejected.
                            }
                        }
                    } else {
                        mkdirSync(modelCacheDir, { recursive: true });
                    }
                    env.cacheDir = modelCacheDir;
                } catch {
                    // Non-fatal — fall back to library default if we can't create the dir
                    log("[magic-context] could not create model cache dir, using library default");
                }
                const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;

                // Cross-process lock — serializes InferenceSession::LoadModel
                // across concurrently-starting OpenCode processes. See the
                // doc block on `acquireModelLoadLock` and issue #21.
                const lockPath = join(modelCacheDir, ".load.lock");
                const releaseLock = await acquireModelLoadLock(lockPath);
                const stopHeartbeat = startLockHeartbeat(lockPath);
                try {
                    // Retry loop absorbs transient failures seen when multiple plugin
                    // processes initialize the ONNX session around the same time:
                    //   - "Protobuf parsing failed" (onnxruntime-node race on mmap/page cache)
                    //   - "Unable to get model file path or buffer" (download still in progress)
                    //   - EBUSY / file lock contention
                    // Recovery happens within a few hundred ms. The file on disk is fine;
                    // we verified this on live logs with matching SHA256 vs HuggingFace.
                    const MAX_ATTEMPTS = 3;
                    let lastError: unknown;
                    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                        try {
                            // NOTE: transformers v4 deprecated the `quantized: boolean`
                            // flag in favor of `dtype` as the canonical precision option.
                            // `this.dtype` defaults to "fp32" to preserve the prior
                            // behavior exactly; a user-configured `embedding.local_dtype`
                            // (e.g. "q8" for a quantized multilingual model) flows through
                            // here. See issue #259.
                            //
                            // device: "auto" is REQUIRED when we injected our own ORT
                            // via Symbol.for("onnxruntime") (the WASM path):
                            // transformers then skips its device-registration branch, so
                            // supportedDevices stays []. Any concrete device (incl. the
                            // "cpu" it defaults to under IS_NODE_ENV) fails the
                            // supportedDevices.includes(device) check and throws
                            // `Unsupported device: "cpu"`. "auto" returns supportedDevices
                            // verbatim ([]) without that check, so onnxruntime-web uses its
                            // own default (wasm) execution provider. Native Node/Bun keeps
                            // the default selection (no device option). See issue #195.
                            const pipeline = await withQuietConsole(() =>
                                createPipeline("feature-extraction", this.model, {
                                    dtype: this.dtype,
                                    ...(usesWasm ? { device: "auto" } : {}),
                                }),
                            );
                            if (this.disposing) {
                                await pipeline.dispose?.();
                                this.pipeline = null;
                            } else {
                                this.pipeline = pipeline;
                            }
                            lastError = undefined;
                            break;
                        } catch (error) {
                            lastError = error;
                            if (!isTransientLoadError(error) || attempt === MAX_ATTEMPTS) {
                                break;
                            }
                            // Jittered backoff: 300ms + random 0-200ms, grows by attempt.
                            const delayMs = 300 * attempt + Math.floor(Math.random() * 200);
                            log(
                                `[magic-context] embedding model load attempt ${attempt}/${MAX_ATTEMPTS} failed transiently, retrying in ${delayMs}ms`,
                            );
                            await new Promise((resolve) => setTimeout(resolve, delayMs));
                        }
                    }

                    if (this.pipeline) {
                        this.lastFailureReason = null;
                        localEmbeddingProcessFailure = null;
                        const memoryAfterLoad = process.memoryUsage();
                        loadedLocalEmbeddingRuntimes.set(this.memoryStatsId, {
                            model: this.model,
                            runtime: this.usesWasm ? "wasm" : "native",
                            rssDeltaAtLoad: memoryAfterLoad.rss - memoryBeforeLoad.rss,
                            externalDeltaAtLoad:
                                memoryAfterLoad.external - memoryBeforeLoad.external,
                            arrayBuffersDeltaAtLoad:
                                memoryAfterLoad.arrayBuffers - memoryBeforeLoad.arrayBuffers,
                        });
                        log(`[magic-context] embedding model loaded: ${this.model}`);
                    } else if (this.disposing) {
                        return;
                    } else {
                        throw lastError ?? new Error("unknown embedding load failure");
                    }
                } finally {
                    stopHeartbeat();
                    await releaseLock();
                }
            } catch (error) {
                const nativeError =
                    error instanceof LocalEmbeddingFallbackError ? error.nativeError : undefined;
                const failure = classifyLocalEmbeddingFailure(error, {
                    platform: process.platform,
                    arch: process.arch,
                    usesWasm: this.usesWasm,
                    nativeError,
                });
                this.lastFailureReason = failure;
                localEmbeddingProcessFailure = failure;

                if (!localEmbeddingRuntimeIsDisabled() && isNativeRuntimeMissingError(error)) {
                    disableLocalEmbeddingsAfterRuntimeFailure(
                        error instanceof Error ? error.message : String(error),
                    );
                }
                logForRuntime(
                    `[magic-context] embedding model failed to load (${failure.class}: ${failure.reason}):`,
                    error,
                );
                this.pipeline = null;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
        return this.pipeline !== null;
    }

    private waitForInFlightToDrain(): Promise<void> {
        if (this.inFlight === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.inFlightWaiters.push(resolve);
        });
    }

    private finishInFlight(): void {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.inFlight !== 0) return;
        const waiters = this.inFlightWaiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
    }

    async embed(
        text: string,
        signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null> {
        // MiniLM and gte-modernbert are plain encoders, so query/document text
        // stays byte-identical unless a future local model owns its own recipe.
        // Local inference is fast (typically <100ms) and can't be cancelled
        // mid-compute with transformers.js, so we honor `signal` only as a
        // pre-flight check — callers whose timeout already fired get null
        // without starting fresh inference work.
        if (signal?.aborted) return null;
        if (this.disposing) return null;

        this.inFlight += 1;

        try {
            if (!(await this.initialize())) {
                return null;
            }

            const pipeline = this.pipeline;
            if (!pipeline) {
                return null;
            }

            const result = await withQuietConsole(() =>
                pipeline(text, {
                    pooling: "mean",
                    normalize: true,
                }),
            );

            const embedding = extractBatchEmbeddings(result, 1)[0] ?? null;
            if (!embedding) {
                this.lastFailureReason = classifyLocalEmbeddingFailure(
                    new Error("local embedding pipeline returned no vector"),
                    { usesWasm: this.usesWasm },
                );
            } else {
                this.lastFailureReason = null;
            }
            return embedding;
        } catch (error) {
            const failure = classifyLocalEmbeddingFailure(error, { usesWasm: this.usesWasm });
            this.lastFailureReason = failure;
            logForRuntime(
                `[magic-context] embedding failed (${failure.class}: ${failure.reason}):`,
                error,
            );
            return null;
        } finally {
            this.finishInFlight();
        }
    }

    async embedBatch(
        texts: string[],
        signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]> {
        // Plain local encoders intentionally receive the original text for both purposes.
        if (texts.length === 0) {
            return [];
        }

        if (signal?.aborted) {
            return Array.from({ length: texts.length }, () => null);
        }

        if (this.disposing) {
            return Array.from({ length: texts.length }, () => null);
        }

        this.inFlight += 1;

        try {
            if (!(await this.initialize())) {
                return Array.from({ length: texts.length }, () => null);
            }

            const pipeline = this.pipeline;
            if (!pipeline) {
                return Array.from({ length: texts.length }, () => null);
            }

            const result = await withQuietConsole(() =>
                pipeline(texts, {
                    pooling: "mean",
                    normalize: true,
                }),
            );

            const embeddings = extractBatchEmbeddings(result, texts.length);
            if (embeddings.every((embedding) => embedding === null)) {
                this.lastFailureReason = classifyLocalEmbeddingFailure(
                    new Error("local embedding pipeline returned no vectors"),
                    { usesWasm: this.usesWasm },
                );
            } else {
                this.lastFailureReason = null;
            }
            return embeddings;
        } catch (error) {
            const failure = classifyLocalEmbeddingFailure(error, { usesWasm: this.usesWasm });
            this.lastFailureReason = failure;
            logForRuntime(
                `[magic-context] embedding batch failed (${failure.class}: ${failure.reason}):`,
                error,
            );
            return Array.from({ length: texts.length }, () => null);
        } finally {
            this.finishInFlight();
        }
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }

        this.disposing = true;
        this.disposePromise = (async () => {
            if (this.initPromise) {
                await this.initPromise;
            }

            await this.waitForInFlightToDrain();

            const pipelineToDispose = this.pipeline;
            this.pipeline = null;
            this.initPromise = null;
            loadedLocalEmbeddingRuntimes.delete(this.memoryStatsId);
            if (!pipelineToDispose) {
                return;
            }

            try {
                await pipelineToDispose.dispose?.();
            } catch (error) {
                log("[magic-context] embedding model dispose failed:", error);
            }
        })();

        return this.disposePromise;
    }

    isLoaded(): boolean {
        return this.pipeline !== null;
    }

    getLastFailureReason(): EmbeddingFailure | null {
        return this.lastFailureReason;
    }
}
