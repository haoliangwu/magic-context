export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Search the archive — everything that ever happened in this project, not just what is on your desk.

Retrieval matches meaning and exact words and fuses them, so phrase \`query\` as a natural-language question that still carries the exact terms you expect in the answer (paths, symbols, config keys, error strings); a bare keyword stack finds less.
- "where is the opencode source code path?"  (a location you once knew)
- "why did we choose SQLite over postgres?"  (a decision and its reasons)
- "how does the dreamer lease work?"  (a mechanism discussed or implemented earlier)
- Not: "upload client retry backoff config"

Results only contain what you CANNOT currently see — memories already in <project-memory> and the live tail are filtered out. A query that is just memory ids (\`#7234\`, \`12, 34\`) resolves them directly.

Sources (omit for all):
- memory — rules, constraints, conventions; "what's our convention for X"
- message — the raw conversation behind compacted history; "did we discuss this"; hits carry ordinals for ctx_expand(start=N-10, end=N+5)
- git_commit — commit history; "when did this change" (pair with message for regression hunts)
- primer — reusable project Q&A the dreamer distils from recurring questions; "have we answered this before"
- note — parked follow-ups with their recorded text; "did we leave a follow-up"
Use from/to to restrict every source to an inclusive UTC date range.`;
export const DEFAULT_CTX_SEARCH_LIMIT = 10;
