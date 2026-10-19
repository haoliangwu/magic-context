import { sameProjectDirectory } from "./project-directory-key";
import { MagicContextRpcClient } from "./rpc-client";

/** History-compression children need the current project plugin's prompt and recognition of their run IDs. */
export async function handoffHistoryWork(args: {
    storageDir: string;
    directory: string;
    sessionId: string;
    method: string;
    params: Record<string, unknown>;
    readDirectory: () => Promise<string | null>;
    findOwner?: typeof MagicContextRpcClient.findSessionOwner;
}): Promise<Record<string, unknown> | undefined> {
    const current = await args.readDirectory();
    if (current && sameProjectDirectory(current, args.directory)) return undefined;
    const action = `Reopen this session in its current project directory${current ? ` (${current})` : ""}, then run /ctx-recomp.`;
    if (!current || args.params.historyHandoff === true)
        return {
            ok: false,
            error: `History recovery could not locate a stable owning instance. ${action}`,
        };
    const owner = await (args.findOwner ?? MagicContextRpcClient.findSessionOwner)(
        args.storageDir,
        args.sessionId,
    );
    if (!owner)
        return {
            ok: false,
            error: `History recovery needs the instance for ${current}. ${action}`,
        };
    try {
        return await owner.call(args.method, {
            ...args.params,
            directory: current,
            historyHandoff: true,
        });
    } catch {
        return {
            ok: false,
            error: `The owning instance could not accept history recovery. ${action}`,
        };
    }
}
