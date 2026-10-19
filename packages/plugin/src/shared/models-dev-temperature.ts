/**
 * Temperature capability from the models.dev catalog that OpenCode caches on disk.
 *
 * OpenCode 1 copies models.dev's `temperature` flag onto each model, but OpenCode 2's
 * model rows, Pi's model registry and Oh My Pi's Gemini models carry no equivalent
 * field. For those hosts the cached catalog is the only positive evidence on the
 * machine, so a missing file, an unparsable file or a missing entry all mean "unknown"
 * and the caller omits temperature.
 *
 * This module is bundled into the Pi/OMP historian child extension, so it must only
 * depend on Node built-ins.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CatalogTemperature {
    temperature: boolean;
    /** The catalog entry that decided, as `provider/model`. */
    entry: string;
}

/**
 * Harness provider ids that name the same models.dev provider. Codex (`openai-codex`)
 * is deliberately absent: the ChatGPT backend is a different transport from the
 * OpenAI API that models.dev describes, so it gets no catalog answer and no temperature.
 */
const CATALOG_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    "google-antigravity": "google",
    "opencode-zen": "opencode",
};

/** The Antigravity auth plugins register Gemini models as `google/antigravity-<model>`. */
const ANTIGRAVITY_MODEL_PREFIX = "antigravity-";

type CatalogIndex = Map<string, boolean>;

let cached: { path: string; mtimeMs: number; size: number; index: CatalogIndex } | undefined;

/** OpenCode reads `OPENCODE_MODELS_PATH` instead of its cache when it is set. */
export function modelsDevCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.OPENCODE_MODELS_PATH) return env.OPENCODE_MODELS_PATH;
    return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
}

function buildIndex(raw: unknown): CatalogIndex {
    const index: CatalogIndex = new Map();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return index;
    for (const [providerID, provider] of Object.entries(raw as Record<string, unknown>)) {
        const models = (provider as { models?: unknown } | null)?.models;
        if (!models || typeof models !== "object") continue;
        for (const [modelID, model] of Object.entries(models as Record<string, unknown>)) {
            const temperature = (model as { temperature?: unknown } | null)?.temperature;
            if (typeof temperature === "boolean")
                index.set(`${providerID}/${modelID}`, temperature);
        }
    }
    return index;
}

function loadIndex(): CatalogIndex | undefined {
    const path = modelsDevCatalogPath();
    try {
        const stat = statSync(path);
        if (cached?.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
            return cached.index;
        const index = buildIndex(JSON.parse(readFileSync(path, "utf8")));
        cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, index };
        return index;
    } catch {
        // Absent or partially written catalog: no evidence either way.
        return undefined;
    }
}

/** Spellings to try for a harness `provider/model` reference, most specific first. */
export function catalogCandidates(providerID: string, modelID: string): string[] {
    const provider = Object.hasOwn(CATALOG_PROVIDER_ALIASES, providerID)
        ? CATALOG_PROVIDER_ALIASES[providerID]
        : providerID;
    const candidates = [`${provider}/${modelID}`];
    if (provider === "google" && modelID.startsWith(ANTIGRAVITY_MODEL_PREFIX))
        candidates.push(`google/${modelID.slice(ANTIGRAVITY_MODEL_PREFIX.length)}`);
    return candidates;
}

/**
 * Look `provider/model` up in the cached catalogue, trying only the exact spellings from
 * `catalogCandidates`. A malformed reference, a missing catalogue or no entry returns undefined.
 */
export function catalogTemperature(model: string): CatalogTemperature | undefined {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return undefined;
    const index = loadIndex();
    if (!index) return undefined;
    for (const entry of catalogCandidates(model.slice(0, slash), model.slice(slash + 1))) {
        const temperature = index.get(entry);
        if (temperature !== undefined) return { temperature, entry };
    }
    return undefined;
}

export const __catalogTest = {
    reset(): void {
        cached = undefined;
    },
};
