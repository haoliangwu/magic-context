import type { ModelCatalogs } from "./types";

export const MODEL_CATALOGS_CACHE_KEY = "magic-context.model-catalogs";

export function loadCachedModelCatalogs(storage: Pick<Storage, "getItem">): ModelCatalogs {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MODEL_CATALOGS_CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return { opencode: [], pi: [], omp: [] };
    const catalogs = parsed as Partial<ModelCatalogs>;
    return {
      opencode: Array.isArray(catalogs.opencode) ? catalogs.opencode : [],
      pi: Array.isArray(catalogs.pi) ? catalogs.pi : [],
      omp: Array.isArray(catalogs.omp) ? catalogs.omp : [],
    };
  } catch {
    return { opencode: [], pi: [], omp: [] };
  }
}

export function retainLoadedCatalogs(
  previous: ModelCatalogs,
  fresh: ModelCatalogs,
  storage: Pick<Storage, "setItem">,
): ModelCatalogs {
  const merged: ModelCatalogs = {
    opencode: fresh.opencode.length ? fresh.opencode : previous.opencode,
    pi: fresh.pi.length ? fresh.pi : previous.pi,
    omp: fresh.omp.length ? fresh.omp : previous.omp,
  };
  // Empty discovery is transient, not an authoritative removal of a provider's models.
  if (merged.opencode.length || merged.pi.length || merged.omp.length) {
    try {
      storage.setItem(MODEL_CATALOGS_CACHE_KEY, JSON.stringify(merged));
    } catch {
      // In-memory models remain available when storage is disabled.
    }
  }
  return merged;
}
