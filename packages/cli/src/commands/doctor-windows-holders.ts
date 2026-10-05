import { existsSync } from "node:fs";
import type { AsyncProcessInspection } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";

/** Windows cannot use lsof: rule out host processes and check SQLite locks without waiting. */
export function assertWindowsStoresClosed(
    paths: string[],
    processes: AsyncProcessInspection,
): void {
    if (
        processes.pi.state !== "known" ||
        processes.pi.processIds.length > 0 ||
        (processes.pi.inconclusivePids?.length ?? 0) > 0 ||
        processes.processSnapshot?.source !== "cim"
    ) {
        throw new Error(
            `Windows process probe could not rule out OpenCode, Pi or ck-mc holders${processes.pi.processIds.length || processes.pi.inconclusivePids?.length ? ` (PID ${[...processes.pi.processIds, ...(processes.pi.inconclusivePids ?? [])].join(", ")})` : ""}`,
        );
    }
    const facts = processes.processSnapshot.facts.filter(({ pid }) => pid !== process.pid);
    const unknown = facts.filter(
        ({ imageName, commandLine }) =>
            (!imageName && !commandLine) ||
            (/^(?:bun|node|deno)(?:\.exe)?$/i.test(imageName ?? "") && !commandLine),
    );
    if (unknown.length)
        throw new Error(
            `Windows process identity is unavailable (PID ${unknown.map(({ pid }) => pid).join(", ")})`,
        );
    const blockers = facts.filter(({ imageName, commandLine }) => {
        const image = (imageName ?? "").toLowerCase().replaceAll("\\", "/").split("/").at(-1) ?? "";
        return (
            /^(?:opencode|opencode2|pi|omp|ck-mc)(?:\.exe)?$/.test(image) ||
            /(?:^|[\\/\s"'])(?:ck-mc|opencode2?)(?:\.exe|\.js|\.mjs)?(?:$|[\s"'])/i.test(
                commandLine ?? "",
            )
        );
    });
    if (blockers.length)
        throw new Error(
            `OpenCode, Pi or ck-mc process is running (${blockers.map(({ pid, imageName, commandLine }) => `${imageName ?? commandLine} PID ${pid}`).join(", ")})`,
        );
    for (const path of [...new Set(paths)]) {
        if (!existsSync(path)) continue;
        let db: Database | undefined;
        let locked = false;
        try {
            db = new Database(path);
            db.exec("PRAGMA busy_timeout = 0");
            db.exec("BEGIN EXCLUSIVE");
            locked = true;
        } catch (error) {
            throw new Error(
                `Cannot acquire exclusive locks on ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            if (locked) db?.exec("ROLLBACK");
            db?.close();
        }
    }
}
