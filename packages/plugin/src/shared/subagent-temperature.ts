import { __catalogTest, catalogTemperature } from "./models-dev-temperature";

export type TemperatureMetadata = {
    temperature?: boolean;
    capabilities?: { temperature?: boolean };
    compat?: { supportsTemperature?: boolean; supportsSamplingParams?: boolean };
};

const loggedDecisions = new Set<string>();

export function temperatureCapability(metadata: unknown): boolean | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;
    const model = metadata as TemperatureMetadata;
    const supported =
        model.capabilities?.temperature ??
        model.temperature ??
        model.compat?.supportsTemperature ??
        model.compat?.supportsSamplingParams;
    return typeof supported === "boolean" ? supported : undefined;
}

/**
 * Where a temperature decision came from: the host's own model metadata, the models.dev
 * catalog OpenCode caches on disk, or nothing (which omits temperature).
 */
export type TemperatureSource = "host" | "catalog" | "none";

export interface TemperatureDecision {
    supported: boolean | undefined;
    source: TemperatureSource;
    /** The models.dev entry (`provider/model`) when the catalog decided. */
    entry?: string;
}

/**
 * Host metadata wins whenever it states a boolean. Only when the host is silent do we
 * consult the cached models.dev catalog, matched by provider and model id.
 */
export function resolveTemperatureCapability(
    model: string,
    metadata: unknown,
): TemperatureDecision {
    const host = temperatureCapability(metadata);
    if (host !== undefined) return { supported: host, source: "host" };
    const catalog = catalogTemperature(model);
    if (catalog) return { supported: catalog.temperature, source: "catalog", entry: catalog.entry };
    return { supported: undefined, source: "none" };
}

export function describeTemperatureDecision(model: string, decision: TemperatureDecision): string {
    const verdict = decision.supported === true ? "sent" : "omitted";
    const answer = decision.supported === true ? "yes" : "no";
    const reason =
        decision.source === "host"
            ? `host model metadata says ${answer}`
            : decision.source === "catalog"
              ? `models.dev cache entry ${decision.entry ?? "unknown"} says ${answer}`
              : "no host or models.dev metadata";
    return `Subagent temperature ${verdict} for ${model}: ${reason}`;
}

/** Log each model's decision once per process, and again only if the decision changes. */
export function logTemperatureDecision(
    model: string,
    decision: TemperatureDecision,
    log: (message: string, decision: TemperatureDecision) => void,
): void {
    const key = `${model}\u0000${decision.source}\u0000${decision.supported}\u0000${decision.entry ?? ""}`;
    if (loggedDecisions.has(key)) return;
    loggedDecisions.add(key);
    log(describeTemperatureDecision(model, decision), decision);
}

/** Only a positive capability permits sampling; reasoning alone is not evidence. */
export function subagentTemperature(
    model: string,
    metadata: unknown,
    temperature: number | undefined,
    log: (message: string, decision: TemperatureDecision) => void,
): number | undefined {
    if (temperature === undefined) return undefined;
    const decision = resolveTemperatureCapability(model, metadata);
    logTemperatureDecision(model, decision, log);
    return decision.supported === true ? temperature : undefined;
}

/** OpenCode 1 computes agent sampling before chat.params resolves the final model. */
export function applyHiddenSubagentTemperature(
    input: { agent: string; model?: TemperatureMetadata & { providerID?: string; id?: string } },
    output: { temperature?: number },
    log: (message: string) => void,
): void {
    if (!/^(?:historian(?:-|$)|dreamer(?:-|$)|smart-note-compiler$)/.test(input.agent)) return;
    const temperature = subagentTemperature(
        `${input.model?.providerID ?? "unknown"}/${input.model?.id ?? "unknown"}`,
        input.model,
        output.temperature,
        // Host loggers treat a second argument as structured data; the message says it all.
        (message) => log(message),
    );
    if (temperature === undefined) delete output.temperature;
    else output.temperature = temperature;
}

export const __temperatureTest = {
    reset(): void {
        loggedDecisions.clear();
        __catalogTest.reset();
    },
};
