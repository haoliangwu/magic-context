import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set isolation before importing modules that resolve storage or model caches.
export function isolate(base = join(tmpdir(), "magic-context", "self-tag-trial")): string {
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, "run-"));
    for (const name of ["data", "cache", "config", "home"]) mkdirSync(join(root, name));
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_CACHE_HOME = join(root, "cache");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.HOME = join(root, "home");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "data", "cortexkit", "magic-context");
    process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "trial.log");
    process.env.OPENCODE_DB = join(root, "data", "opencode", "opencode.db");
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_DIR = join(root, "config");
    return root;
}

export function forbiddenOpenPaths(lsof: string, liveHome: string): string[] {
    const roots = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit"];
    return lsof.split("\n").filter(line => line.startsWith("n/") && roots.some(path => line.slice(1).startsWith(join(liveHome, path) + "/")));
}

export const instructionB = "Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.";

export const instructionC = 'Every user message, every text you write and every tool result in this conversation carries a tag such as §12§, numbered in the order they arrive. Start the text of each reply with exactly §N§ and one space, where N is one more than the highest tag number you can see, tool results included. That applies to every reply that has text, including a short sentence written alongside tool calls, for example `§12§ Reading both files in parallel.` followed by the calls. A reply that is only tool calls gets no tag. IMPORTANT: NEVER write tag notation anywhere else: not mid-text and not in tool arguments. To refer to an item in your prose, write "tag 12".';
