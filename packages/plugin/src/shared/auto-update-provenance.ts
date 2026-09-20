import { existsSync, readFileSync } from "node:fs";

export const AUTO_UPDATE_CHECK_STATE_FILENAME = "last-update-check.json";

export interface AutoUpdateCheckState {
    lastCheckedMs?: number;
    updaterPinnedSpec?: string;
    updaterPinnedAt?: number;
}

export function readAutoUpdateCheckState(path: string): AutoUpdateCheckState | null {
    if (!existsSync(path)) return null;
    try {
        const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const raw = value as Record<string, unknown>;
        const state: AutoUpdateCheckState = {};
        if (typeof raw.lastCheckedMs === "number" && Number.isFinite(raw.lastCheckedMs)) {
            state.lastCheckedMs = raw.lastCheckedMs;
        }
        if (typeof raw.updaterPinnedSpec === "string" && raw.updaterPinnedSpec.length > 0) {
            state.updaterPinnedSpec = raw.updaterPinnedSpec;
        }
        if (typeof raw.updaterPinnedAt === "number" && Number.isFinite(raw.updaterPinnedAt)) {
            state.updaterPinnedAt = raw.updaterPinnedAt;
        }
        return state;
    } catch {
        return null;
    }
}

export function isUpdaterPinnedSpec(
    state: AutoUpdateCheckState | null,
    configuredSpec: string,
): boolean {
    return (
        state?.updaterPinnedSpec === configuredSpec &&
        typeof state.updaterPinnedAt === "number" &&
        Number.isFinite(state.updaterPinnedAt)
    );
}
