import { appendFileSync } from "node:fs";
import { join } from "node:path";
import hidden from "./hidden-s3-probe";

export default {
    id: "mc-fold-s3-proof",
    async setup(context: any) {
        for (const kind of ["context", "compaction"]) await context.session.hook(kind, (draft: any) => {
            appendFileSync(join(context.location.directory, "s3-fold.jsonl"), JSON.stringify({ kind, sessionID: draft.sessionID, messages: draft.messages, result: draft.result }) + "\n");
        });
        await hidden.setup(context);
    },
};
