import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { writeStorageFileAsync } from "../../../shared/storage-permissions";

export type LocalEmbeddingPoolingMethod = "mean" | "cls" | "last_token";

export interface LocalEmbeddingPoolingMetadata {
    status: "ready" | "unresolved" | "unsupported";
    pooling?: LocalEmbeddingPoolingMethod;
    normalize: boolean;
    declared: boolean;
    reason: string;
}

export type LocalEmbeddingPoolingFetch = (url: string) => Promise<Response>;

const decisionLogged = new Set<string>();
const unavailableLogged = new Set<string>();
const metadataByCache = new Map<string, LocalEmbeddingPoolingMetadata>();
const testMetadataByModel = new Map<string, LocalEmbeddingPoolingMetadata | null>();
let testMetadataFallback: LocalEmbeddingPoolingMetadata | null | undefined;

export const UNRESOLVED_LOCAL_EMBEDDING_POOLING: LocalEmbeddingPoolingMetadata = {
    status: "unresolved",
    pooling: "mean",
    normalize: true,
    declared: false,
    reason: "pooling metadata is unavailable; preserving legacy mean pooling and normalization",
};

const LEGACY_MEAN_POOLING: LocalEmbeddingPoolingMetadata = {
    status: "ready",
    pooling: "mean",
    normalize: true,
    declared: false,
    reason: "no sentence-transformers Pooling module is declared; preserving legacy mean pooling and normalization",
};

function defaultModelCacheDir(): string {
    return join(getMagicContextStorageDir(), "models");
}

function metadataDirectory(model: string, modelCacheDir: string): string {
    const digest = createHash("sha256").update(model).digest("hex");
    return join(modelCacheDir, ".pooling-metadata", digest);
}

function parseJson(text: string, label: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(
            `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelDirectory(model: string): boolean {
    try {
        return statSync(model).isDirectory();
    } catch {
        return false;
    }
}

function isPoolingModule(value: unknown): value is { path?: string; type?: string; name?: string } {
    if (!isRecord(value)) return false;
    return (
        (typeof value.type === "string" && /(?:^|\.)Pooling$/.test(value.type)) ||
        (typeof value.name === "string" && value.name.toLowerCase() === "pooling")
    );
}

function isNormalizeModule(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return (
        (typeof value.type === "string" && /(?:^|\.)Normalize$/.test(value.type)) ||
        (typeof value.name === "string" && value.name.toLowerCase() === "normalize")
    );
}

function safeModulePath(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const pieces = value.replaceAll("\\", "/").split("/");
    if (pieces.some((piece) => piece === ".." || piece === ".")) return null;
    return pieces.filter(Boolean).join("/");
}

function poolingFromFiles(
    modulesText: string | null,
    configText: string | null,
    label: string,
): LocalEmbeddingPoolingMetadata {
    if (modulesText === null) return LEGACY_MEAN_POOLING;
    const modulesValue = parseJson(modulesText, `${label}/modules.json`);
    if (!Array.isArray(modulesValue)) {
        return {
            status: "unsupported",
            normalize: false,
            declared: true,
            reason: "modules.json is not a module list",
        };
    }
    const poolingModule = modulesValue.find(isPoolingModule);
    if (!poolingModule) return LEGACY_MEAN_POOLING;
    const modulePath = safeModulePath(poolingModule.path);
    if (modulePath === null || configText === null) {
        return {
            status: "unsupported",
            normalize: modulesValue.some(isNormalizeModule),
            declared: true,
            reason: `Pooling module at ${String(poolingModule.path ?? "<missing path>")} has no readable config.json`,
        };
    }
    const config = parseJson(configText, `${label}/${modulePath}/config.json`);
    if (!isRecord(config)) {
        return {
            status: "unsupported",
            normalize: modulesValue.some(isNormalizeModule),
            declared: true,
            reason: `Pooling config at ${modulePath}/config.json is not an object`,
        };
    }

    const enabledModes = [
        ["pooling_mode_cls_token", "cls"],
        ["pooling_mode_mean_tokens", "mean"],
        ["pooling_mode_lasttoken", "last_token"],
        ["pooling_mode_max_tokens", undefined],
        ["pooling_mode_mean_sqrt_len_tokens", undefined],
        ["pooling_mode_weightedmean_tokens", undefined],
        ["pooling_mode_mean_last_token", undefined],
    ].filter(([key]) => config[key as string] === true);
    const normalize = modulesValue.some(isNormalizeModule);
    if (enabledModes.length !== 1) {
        return {
            status: "unsupported",
            normalize,
            declared: true,
            reason:
                enabledModes.length === 0
                    ? `Pooling config at ${modulePath}/config.json enables no pooling mode`
                    : `Pooling config enables multiple modes: ${enabledModes.map(([key]) => key).join(", ")}`,
        };
    }

    const [flag, method] = enabledModes[0] as [string, LocalEmbeddingPoolingMethod | undefined];
    if (!method) {
        return {
            status: "unsupported",
            normalize,
            declared: true,
            reason: `unsupported declared pooling mode ${flag}`,
        };
    }
    return {
        status: "ready",
        pooling: method,
        normalize,
        declared: true,
        reason: `modules.json declares ${flag}; ${normalize ? "a Normalize module is present" : "no Normalize module is declared"}`,
    };
}

function poolingMetadataCacheKey(model: string, modelCacheDir: string): string {
    return JSON.stringify([model, modelCacheDir]);
}

function cachedMetadataPath(model: string, modelCacheDir: string): string {
    return join(metadataDirectory(model, modelCacheDir), "resolution.json");
}

function parseCachedMetadata(text: string): LocalEmbeddingPoolingMetadata | null {
    try {
        const value = JSON.parse(text) as unknown;
        if (!isRecord(value) || (value.status !== "ready" && value.status !== "unsupported"))
            return null;
        if (
            typeof value.normalize !== "boolean" ||
            typeof value.declared !== "boolean" ||
            typeof value.reason !== "string"
        )
            return null;
        if (
            value.status === "ready" &&
            value.pooling !== "mean" &&
            value.pooling !== "cls" &&
            value.pooling !== "last_token"
        )
            return null;
        return value as unknown as LocalEmbeddingPoolingMetadata;
    } catch {
        return null;
    }
}

function readDirectoryMetadata(model: string): LocalEmbeddingPoolingMetadata {
    const modulesPath = join(model, "modules.json");
    if (!existsSync(modulesPath)) return LEGACY_MEAN_POOLING;
    const modulesText = readFileSync(modulesPath, "utf8");
    const moduleList = parseJson(modulesText, `${model}/modules.json`);
    if (!Array.isArray(moduleList)) {
        return {
            status: "unsupported",
            normalize: false,
            declared: true,
            reason: "modules.json is not a module list",
        };
    }
    const poolingModule = moduleList.find(isPoolingModule);
    const modulePath = poolingModule ? safeModulePath(poolingModule.path) : null;
    const configText = modulePath
        ? readFileSync(join(model, modulePath, "config.json"), "utf8")
        : null;
    return poolingFromFiles(modulesText, configText, model);
}

export function getCachedLocalEmbeddingPooling(
    model: string,
    modelCacheDir = defaultModelCacheDir(),
): LocalEmbeddingPoolingMetadata | null {
    if (testMetadataByModel.has(model)) return testMetadataByModel.get(model) ?? null;
    const cacheKey = poolingMetadataCacheKey(model, modelCacheDir);
    const cachedInMemory = metadataByCache.get(cacheKey);
    if (cachedInMemory) return cachedInMemory;
    if (isModelDirectory(model)) {
        try {
            const metadata = readDirectoryMetadata(model);
            metadataByCache.set(cacheKey, metadata);
            return metadata;
        } catch (error) {
            const metadata: LocalEmbeddingPoolingMetadata = {
                status: "unsupported",
                normalize: false,
                declared: true,
                reason: error instanceof Error ? error.message : String(error),
            };
            metadataByCache.set(cacheKey, metadata);
            return metadata;
        }
    }
    try {
        const cached = parseCachedMetadata(
            readFileSync(cachedMetadataPath(model, modelCacheDir), "utf8"),
        );
        if (cached) {
            metadataByCache.set(cacheKey, cached);
            return cached;
        }
    } catch {
        // A failed read of cached pooling metadata leaves it unresolved until preflight resolves it.
    }
    if (testMetadataFallback) {
        metadataByCache.set(cacheKey, testMetadataFallback);
        return testMetadataFallback;
    }
    metadataByCache.set(cacheKey, UNRESOLVED_LOCAL_EMBEDDING_POOLING);
    return UNRESOLVED_LOCAL_EMBEDDING_POOLING;
}

export function logLocalEmbeddingPoolingDecisionOnce(
    model: string,
    metadata: LocalEmbeddingPoolingMetadata,
    logger: (message: string, data?: unknown) => void = log,
): void {
    const decisionKey = `${model}:${metadata.status}:${metadata.pooling ?? "none"}:${metadata.normalize}`;
    if (decisionLogged.has(decisionKey)) return;
    decisionLogged.add(decisionKey);
    if (metadata.status === "unsupported") {
        logger(
            `[magic-context] local embedding pooling for ${model} is unsupported: ${metadata.reason}`,
        );
    } else {
        logger(
            `[magic-context] local embedding pooling for ${model}: ${metadata.pooling} pooling, normalization ${metadata.normalize ? "enabled" : "disabled"} (${metadata.reason})`,
        );
    }
}

function logUnavailableOnce(
    model: string,
    reason: string,
    logger: (message: string, data?: unknown) => void,
): void {
    if (unavailableLogged.has(model)) return;
    unavailableLogged.add(model);
    logger(
        `[magic-context] local embedding pooling metadata for ${model} is not available: ${reason}; using legacy mean pooling and retrying during a later background bootstrap`,
    );
}

function remoteHost(): string {
    const configured = process.env.HF_ENDPOINT?.trim().replace(/\/+$/, "");
    return configured || "https://huggingface.co";
}

function safeRepoId(repo: string): boolean {
    return (
        repo.length > 0 && repo.split("/").every((part) => part && part !== "." && part !== "..")
    );
}

function modelFileUrl(host: string, repo: string, file: string): string {
    const path = repo.split("/").map(encodeURIComponent).join("/");
    const filePath = file.split("/").map(encodeURIComponent).join("/");
    return `${host}/${path}/resolve/main/${filePath}`;
}

async function fetchModelFile(
    host: string,
    repo: string,
    file: string,
    fetcher: LocalEmbeddingPoolingFetch,
): Promise<{ kind: "found"; text: string } | { kind: "missing" }> {
    const response = await fetcher(modelFileUrl(host, repo, file));
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${repo}/${file}`);
    return { kind: "found", text: await response.text() };
}

async function filesForRepo(
    host: string,
    repo: string,
    fetcher: LocalEmbeddingPoolingFetch,
): Promise<{
    modulesText: string | null;
    configText: string | null;
    configPath: string | null;
    rootConfig: string | null;
    rootModules: string | null;
}> {
    const modules = await fetchModelFile(host, repo, "modules.json", fetcher);
    if (modules.kind === "missing") {
        const rootConfigResult = await fetchModelFile(host, repo, "config.json", fetcher);
        if (rootConfigResult.kind === "missing") {
            return {
                modulesText: null,
                configText: null,
                configPath: null,
                rootConfig: null,
                rootModules: null,
            };
        }
        const rootConfigValue = parseJson(rootConfigResult.text, `${repo}/config.json`);
        const origin =
            isRecord(rootConfigValue) && typeof rootConfigValue._name_or_path === "string"
                ? rootConfigValue._name_or_path.trim()
                : "";
        // ONNX exports often omit sentence-transformers files but keep the source model ID here.
        // Read that source's pooling declaration rather than silently treating the export as mean.
        if (!origin || origin === repo || !safeRepoId(origin)) {
            return {
                modulesText: null,
                configText: null,
                configPath: null,
                rootConfig: rootConfigResult.text,
                rootModules: null,
            };
        }
        const originModules = await fetchModelFile(host, origin, "modules.json", fetcher);
        if (originModules.kind === "missing") {
            return {
                modulesText: null,
                configText: null,
                configPath: null,
                rootConfig: rootConfigResult.text,
                rootModules: null,
            };
        }
        const originModuleList = parseJson(originModules.text, `${origin}/modules.json`);
        if (!Array.isArray(originModuleList)) {
            return {
                modulesText: originModules.text,
                configText: null,
                configPath: null,
                rootConfig: rootConfigResult.text,
                rootModules: originModules.text,
            };
        }
        const poolingModule = originModuleList.find(isPoolingModule);
        const modulePath = poolingModule ? safeModulePath(poolingModule.path) : null;
        if (!modulePath) {
            return {
                modulesText: originModules.text,
                configText: null,
                configPath: null,
                rootConfig: rootConfigResult.text,
                rootModules: originModules.text,
            };
        }
        const poolingConfig = await fetchModelFile(
            host,
            origin,
            `${modulePath}/config.json`,
            fetcher,
        );
        if (poolingConfig.kind === "missing") {
            return {
                modulesText: originModules.text,
                configText: null,
                configPath: `${origin}/${modulePath}/config.json`,
                rootConfig: rootConfigResult.text,
                rootModules: originModules.text,
            };
        }
        return {
            modulesText: originModules.text,
            configText: poolingConfig.text,
            configPath: `${origin}/${modulePath}/config.json`,
            rootConfig: rootConfigResult.text,
            rootModules: originModules.text,
        };
    }

    const modulesValue = parseJson(modules.text, `${repo}/modules.json`);
    if (!Array.isArray(modulesValue)) {
        return {
            modulesText: modules.text,
            configText: null,
            configPath: null,
            rootConfig: null,
            rootModules: modules.text,
        };
    }
    const poolingModule = modulesValue.find(isPoolingModule);
    const modulePath = poolingModule ? safeModulePath(poolingModule.path) : null;
    if (!modulePath) {
        return {
            modulesText: modules.text,
            configText: null,
            configPath: null,
            rootConfig: null,
            rootModules: modules.text,
        };
    }
    const poolingConfig = await fetchModelFile(host, repo, `${modulePath}/config.json`, fetcher);
    return {
        modulesText: modules.text,
        configText: poolingConfig.kind === "found" ? poolingConfig.text : null,
        configPath: `${repo}/${modulePath}/config.json`,
        rootConfig: null,
        rootModules: modules.text,
    };
}

async function cacheRemoteFiles(
    model: string,
    modelCacheDir: string,
    files: {
        modulesText: string | null;
        configText: string | null;
        configPath: string | null;
        rootConfig: string | null;
        rootModules: string | null;
    },
): Promise<void> {
    const root = metadataDirectory(model, modelCacheDir);
    const writes: Promise<void>[] = [];
    if (files.rootConfig !== null)
        writes.push(writeStorageFileAsync(join(root, "config.json"), files.rootConfig, true));
    if (files.rootModules !== null)
        writes.push(writeStorageFileAsync(join(root, "modules.json"), files.rootModules, true));
    if (files.configText !== null && files.configPath !== null) {
        const slash = files.configPath.indexOf("/");
        const repo = files.configPath.slice(0, slash);
        const relative = files.configPath.slice(slash + 1);
        writes.push(
            writeStorageFileAsync(join(root, "source", repo, relative), files.configText, true),
        );
    }
    await Promise.all(writes);
}

export async function preflightLocalEmbeddingPooling(
    model: string,
    options: {
        modelCacheDir?: string;
        fetcher?: LocalEmbeddingPoolingFetch;
        logger?: (message: string, data?: unknown) => void;
    } = {},
): Promise<LocalEmbeddingPoolingMetadata> {
    const cacheDir = options.modelCacheDir ?? defaultModelCacheDir();
    const logger = options.logger ?? log;
    const cacheKey = poolingMetadataCacheKey(model, cacheDir);
    const cached = getCachedLocalEmbeddingPooling(model, cacheDir);
    if (cached && cached.status !== "unresolved") {
        logLocalEmbeddingPoolingDecisionOnce(model, cached, logger);
        return cached;
    }
    if (isModelDirectory(model)) {
        try {
            const metadata = readDirectoryMetadata(model);
            metadataByCache.set(cacheKey, metadata);
            testMetadataByModel.delete(model);
            logLocalEmbeddingPoolingDecisionOnce(model, metadata, logger);
            return metadata;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const metadata: LocalEmbeddingPoolingMetadata = {
                status: "unsupported",
                normalize: false,
                declared: true,
                reason,
            };
            metadataByCache.set(cacheKey, metadata);
            testMetadataByModel.delete(model);
            logLocalEmbeddingPoolingDecisionOnce(model, metadata, logger);
            return metadata;
        }
    }

    try {
        const fetcher =
            options.fetcher ??
            ((url: string) => fetch(url, { signal: AbortSignal.timeout(20_000) }));
        const files = await filesForRepo(remoteHost(), model, fetcher);
        let metadata: LocalEmbeddingPoolingMetadata;
        try {
            metadata = poolingFromFiles(files.modulesText, files.configText, model);
        } catch (error) {
            metadata = {
                status: "unsupported",
                normalize: false,
                declared: true,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        await cacheRemoteFiles(model, cacheDir, files);
        await writeStorageFileAsync(
            cachedMetadataPath(model, cacheDir),
            JSON.stringify(metadata),
            true,
        );
        metadataByCache.set(cacheKey, metadata);
        testMetadataByModel.delete(model);
        logLocalEmbeddingPoolingDecisionOnce(model, metadata, logger);
        return metadata;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        metadataByCache.set(cacheKey, UNRESOLVED_LOCAL_EMBEDDING_POOLING);
        testMetadataByModel.delete(model);
        logUnavailableOnce(model, reason, logger);
        return UNRESOLVED_LOCAL_EMBEDDING_POOLING;
    }
}

export function logLocalEmbeddingPoolingUnavailableOnce(
    model: string,
    reason: string,
    logger: (message: string, data?: unknown) => void = log,
): void {
    logUnavailableOnce(model, reason, logger);
}

export function __setLocalEmbeddingPoolingForTests(
    model: string,
    metadata: LocalEmbeddingPoolingMetadata | null,
): void {
    testMetadataByModel.set(model, metadata);
}

export function __setLocalEmbeddingPoolingTestFallback(
    metadata: LocalEmbeddingPoolingMetadata | null | undefined,
): void {
    testMetadataFallback = metadata;
}

export function __resetLocalEmbeddingPoolingForTests(): void {
    metadataByCache.clear();
    testMetadataByModel.clear();
    decisionLogged.clear();
    unavailableLogged.clear();
    // Preserve the package preload's default for fake model IDs; clear only per-model overrides.
}
