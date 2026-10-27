import { retainProjectEmbedding } from "../../features/magic-context/project-embedding-registry";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { Database } from "../../shared/sqlite";

/** Retain each project's embeddings once per context and release them when the context is disposed. */
export function createV2EmbeddingScope(initialProject?: string) {
    const releases = new Map<string, () => void>();
    const pending = new Set<Promise<void>>();
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const claim = (project: string) => {
        if (!releases.has(project)) releases.set(project, retainProjectEmbedding(project));
    };
    if (initialProject) claim(initialProject);
    return {
        ensureRegistered(directory: string, db: Database): Promise<void> {
            if (disposed) return Promise.resolve();
            const registration = ensureProjectRegisteredFromOpenCodeDirectory(directory, db, {
                onRegistered: claim,
            });
            pending.add(registration);
            return registration.finally(() => pending.delete(registration));
        },
        dispose(): Promise<void> {
            disposed = true;
            disposal ??= (async () => {
                // A routing lookup already in progress may still publish a registration.
                await Promise.allSettled([...pending]);
                for (const release of releases.values()) release();
                releases.clear();
            })();
            return disposal;
        },
    };
}
