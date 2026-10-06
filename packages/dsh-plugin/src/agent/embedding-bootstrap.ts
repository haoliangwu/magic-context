/**
 * agent/embedding-bootstrap — per-project embedding provider registration.
 *
 * Mirror of the OpenCode plugin's plugin/embedding-bootstrap.ts (the shared
 * core exposes every building block; this adapter only bridges the config
 * load to registerProjectEmbedding with an mtime-keyed cache). Without this
 * registration the DSH side leaves getProjectEmbeddingSnapshot() null for
 * every project: ctx_search semantic lanes stay off, /ctx-embed reports
 * "disabled", and the git-commit sweep never indexes.
 *
 * Deviations from the OpenCode version:
 *  - logger injected (the agent plane routes through ctx.logger);
 *  - identical cache policy (mtime+size fingerprint; {env:}/{file:} inputs
 *    bypass the cache).
 */
import { readFileSync, statSync } from "node:fs";
import {
  type LoadResultDetailed,
  loadPluginConfigDetailed,
} from "@magic-context/core/config";
import {
  cortexKitProjectConfigBasePath,
  cortexKitUserConfigBasePath,
  resolveLegacyConfigSources,
} from "@magic-context/core/config/migrate-config-location";
import {
  type EmbeddingFeatures,
  getProjectEmbeddingSnapshot,
  registerProjectEmbedding,
  registerProjectShadowEmbedding,
  unregisterProjectShadowEmbedding,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateProject } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  handleUntrustedLoad,
  isConfigLoadUntrusted,
} from "@magic-context/core/plugin/embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "@magic-context/core/plugin/embedding-routing";

const configCache = new Map<string, { key: string; detailed: LoadResultDetailed }>();
const CONFIG_CACHE_MAX = 64;

function loadRegistrationConfig(directory: string): LoadResultDetailed {
  const legacy = resolveLegacyConfigSources(directory);
  const paths = [
    cortexKitUserConfigBasePath(),
    cortexKitProjectConfigBasePath(directory),
  ]
    .flatMap((base) => [`${base}.jsonc`, `${base}.json`])
    .concat(
      legacy.user.map((source) => source.path),
      legacy.project.map((source) => source.path),
    );
  const key = paths
    .map((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return `${path}:${stat?.mtimeMs ?? "missing"}:${stat?.size ?? 0}`;
    })
    .join("|");
  const cached = configCache.get(directory);
  if (cached?.key === key) return cached.detailed;
  const detailed = loadPluginConfigDetailed(directory);
  // {env:...} and {file:...} inputs can change without the config files
  // changing, so their resolved values cannot be cached by config mtime.
  const dynamic = paths.some((path) => {
    try {
      return /\{(?:env|file):/.test(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  });
  if (!dynamic) {
    if (configCache.size >= CONFIG_CACHE_MAX) {
      const oldest = configCache.keys().next().value;
      if (oldest !== undefined) configCache.delete(oldest);
    }
    configCache.set(directory, { key, detailed });
  } else {
    configCache.delete(directory);
  }
  return detailed;
}

/** Drop the per-directory config cache (tests reset state between cases). */
export function resetEmbeddingBootstrapCacheForTests(): void {
  configCache.clear();
}

/**
 * Load the Magic config for `directory` and (re)register the project's
 * embedding provider. Idempotent per config fingerprint: an unchanged
 * config short-circuits after the identity resolution, so the dreamer tick
 * may call this every 15 minutes without I/O growth.
 */
export async function ensureProjectRegisteredFromDshDirectory(
  directory: string,
  db: Database,
  log: (message: string) => void = () => {},
): Promise<void> {
  const detailed = loadRegistrationConfig(directory);
  const projectIdentity = resolveProjectIdentityForSession(
    directory,
    detailed.config.allow_home_project,
  );
  if (!projectIdentity) return;
  if (isConfigLoadUntrusted(detailed)) {
    handleUntrustedLoad(db, projectIdentity, directory, detailed);
    return;
  }

  const routing = await resolveEmbeddingRouting({
    config: detailed.config,
    projectRoot: directory,
    session: `bootstrap:${projectIdentity}`,
  });
  for (const warning of routing.warnings) {
    log(`[magic-context] ${warning}`);
  }

  const features: EmbeddingFeatures = {
    memoryEnabled: detailed.config.memory.enabled,
    gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
  };
  const before = getProjectEmbeddingSnapshot(projectIdentity);
  const registered = registerProjectEmbedding(
    db,
    projectIdentity,
    routing.primary,
    features,
    directory,
  );
  if (
    !before ||
    before.providerIdentity !== registered.providerIdentity ||
    before.runtimeFingerprint !== registered.runtimeFingerprint
  ) {
    invalidateProject(projectIdentity);
  }
  if (routing.shadow) {
    registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);
  } else {
    unregisterProjectShadowEmbedding(projectIdentity);
  }
}
