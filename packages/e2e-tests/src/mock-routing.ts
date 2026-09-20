import type { Database } from "bun:sqlite";

/** Keep child agents on the same explicitly registered mock model as their host. */
export function pinMockAgents(
  overrides: Record<string, unknown> = {},
  model: string,
  harness: "opencode" | "opencode2" | "pi" | "omp" = "opencode",
): Record<string, unknown> {
  const result = { ...overrides };
  for (const name of ["historian", "dreamer"]) {
    const supplied = overrides[name];
    const agent =
      supplied && typeof supplied === "object" ? (supplied as Record<string, unknown>) : {};
    const pinned = {
      ...(name === "dreamer" && supplied === undefined ? { disable: true } : {}),
      ...agent,
      model: agent.model || model,
    };
    for (const config of [
      pinned,
      ...["opencode", "pi", "omp"]
        .map((host) => agent[host])
        .filter((value) => value && typeof value === "object"),
    ]) {
      const scoped = config as Record<string, unknown>;
      const models = [
        scoped.model,
        ...(Array.isArray(scoped.fallback_models) ? scoped.fallback_models : []),
      ];
      for (const candidate of models) {
        if (candidate && candidate !== model)
          throw new Error(`${name} must use mock model ${model}, got ${candidate}`);
      }
    }
    // Write the current schema directly: migration warnings are user messages
    // and can otherwise add an unrelated model turn in ordering-sensitive tests.
    const {
      model: _model,
      fallback_models: fallback,
      ...settings
    } = pinned as Record<string, unknown>;
    const host =
      agent[harness] && typeof agent[harness] === "object"
        ? (agent[harness] as Record<string, unknown>)
        : {};
    result[name] = {
      ...settings,
      [harness]: { ...(fallback ? { fallback_models: fallback } : {}), ...host, model },
    };
  }
  return result;
}

/** Check recorded attempts, not just mock captures: a failed external call can fall back successfully. */
export function assertHistorianMockRouting(db: Database, harness: string, model: string): void {
  const attempts = db
    .prepare(
      "SELECT subagent, provider_id, model_id FROM subagent_invocations WHERE harness = ? AND subagent IN ('historian', 'historian_editor', 'recomp', 'dreamer')",
    )
    .all(harness) as Array<{
    subagent: string;
    provider_id: string | null;
    model_id: string | null;
  }>;
  for (const attempt of attempts) {
    const actual = `${attempt.provider_id}/${attempt.model_id}`;
    if (actual !== model) {
      throw new Error(`Off-mock ${attempt.subagent} request: ${actual}; expected ${model}`);
    }
  }
}

export function assertMockEndpoint(actual: unknown, expected: string): void {
  if (
    actual !== expected ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(expected).hostname)
  ) {
    throw new Error(`Off-mock provider endpoint: ${String(actual)}; expected loopback ${expected}`);
  }
}

/** Validate the resolved provider list, not just the config submitted to OpenCode. */
export function assertMockProviders(value: unknown, expected: string): void {
  const providers = (value as { providers?: Array<{ options?: { baseURL?: string } }> })?.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("Missing effective mock providers");
  }
  for (const provider of providers) assertMockEndpoint(provider.options?.baseURL, expected);
}
