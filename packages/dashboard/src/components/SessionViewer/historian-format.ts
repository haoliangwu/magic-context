function compactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0";
  const absolute = Math.abs(tokens);
  if (absolute < 1_000) return Math.round(tokens).toLocaleString("en");
  if (absolute < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatHistorianProviderModel(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): string {
  return `${providerId || "—"} / ${modelId || "—"}`;
}

export function formatHistorianDuration(
  startedAt: number,
  endedAt: number | null | undefined,
): string {
  if (endedAt == null || !Number.isFinite(endedAt) || !Number.isFinite(startedAt)) return "—";
  return `${(Math.max(0, endedAt - startedAt) / 1_000).toFixed(1)} s`;
}

export function formatHistorianTokens(inputTokens: number, outputTokens: number): string {
  return `${compactTokenCount(inputTokens)} in · ${compactTokenCount(outputTokens)} out`;
}
