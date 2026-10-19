function validEpoch(timestamp: number | null | undefined): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, "0");
  const month = date.toLocaleString("en", { month: "short" });
  return `${month} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Show exact transcript boundaries when known, otherwise the stored creation time. */
export function formatCompartmentDateSpan(
  startTime: number | null | undefined,
  endTime: number | null | undefined,
  createdAt: number | null | undefined,
): string | undefined {
  if (validEpoch(startTime) && validEpoch(endTime)) {
    return `${formatDateTime(startTime)} → ${formatDateTime(endTime)}`;
  }
  return validEpoch(createdAt) ? `created ${formatDateTime(createdAt)}` : undefined;
}
