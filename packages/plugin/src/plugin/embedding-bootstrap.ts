import { readFileSync, statSync } from "node:fs";
import { type LoadResultDetailed, loadPluginConfigDetailed } from "../config";
import {
    cortexKitProjectConfigBasePath,
    cortexKitUserConfigBasePath,
    resolveLegacyConfigSources,
} from "../config/migrate-config-location";
import {
    type EmbeddingFeatures,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
    unregisterProjectShadowEmbedding,
} from "../features/magic-context/memory/embedding";
import { invalidateProject } from "../features/magic-context/memory/embedding-cache";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { handleUntrustedLoad, isConfigLoadUntrusted } from "./embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "./embedding-routing";

const configCache = new Map<string, { key: string; detailed: LoadResultDetailed }>();

function loadRegistrationConfig(directory: string): LoadResultDetailed {
    const legacy = resolveLegacyConfigSources(directory);
    const paths = [cortexKitUserConfigBasePath(), cortexKitProjectConfigBasePath(directory)]
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
        if (configCache.size >= 64) {
            const oldest = configCache.keys().next().value;
            if (oldest !== undefined) configCache.delete(oldest);
        }
        configCache.set(directory, { key, detailed });
    } else configCache.delete(directory);
    return detailed;
}

export async function ensureProjectRegisteredFromOpenCodeDirectory(
    directory: string,
    db: Database,
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
    )
        invalidateProject(projectIdentity);
    if (routing.shadow) {
        registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);
    } else {
        unregisterProjectShadowEmbedding(projectIdentity);
    }
}
