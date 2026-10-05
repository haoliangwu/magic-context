# Opus 5.5 trim-only live attempt: blocked by subscription rate limits

Date: 2026-10-04 UTC. Host: **OpenCode 1.18.30**. MC base:
`0cd19e6fcf5bf4a2cfcb0e433ff5afc0c4fcceff`. Installed read-only auth dists:
`anthropic-auth` **1.23.0**, `openai-auth` **0.11.0**.

## Result — not a live acceptance proof

**The pending check remains pending.** The first generation request on both the
primary Claude account and the one explicitly authorized alternate returned
**HTTP 429 `rate_limit_error`**. No thinking was generated. No multi-turn,
trim-only, mixed-edit, or cache follow-up call was reached. Neither rejection is
an Anthropic signature/prefix-mismatch result. No 400 from Anthropic was observed;
that is not evidence of acceptance.

The reviewer authorized read-only access to exactly the harness's own
`~/.config/cortexkit/mc-e2e/enrollment.json`, and read-only source/dist inspection of
the two auth plugin checkouts. No operator OpenCode/config/auth store was opened.
After the primary 429, the reviewer authorized **only** `oauth:anthropic:ufuk2` in
a separate bounded run, with instructions to stop if it was also rate-limited.
It was; no third account was tried and no further live calls were made.

## Requests, responses, and spend

Each run used a new root below `$TMPDIR/magic-context/bg_2e0efd96/` and ran under
`timeout --kill-after=30s 600s`. `MC_LIVE_MAX_CALLS=24` bounded each run. The same
short twelve-echo seed prompt was used; twelve steps permit MC's minimum age of
ten tags without large tool results. The subscription plugin actually shaped the
request: adaptive thinking with `display:"summarized"`, low effort, max output
**1024**, and subscription-prefixed tools. The final request body was **46,924
bytes**, including the host/MC system prompt and tool definitions (not a measured
token count). Requested model on the recorded wire: `claude-opus-5-5`.

| Run / account | Phase reached | Upstream response | Request ID | Input / cache read / cache write / output usage | Diagnostics |
| --- | --- | --- | --- | --- | --- |
| `live-1` / primary | Host startup, no provider request | Plugin rejected an access-only slot with an empty refresh field (`custody state mismatch: FAIL_CLOSED`) | none | none | No provider response |
| `live-2` / `oauth:anthropic` | First seed request | 429, `rate_limit_error` | `req_011CfgMd6aTNsQUjqDA2YM19` | All absent (`usage:null`) | No `input_transformations` or equivalent diagnostic in the error response |
| `live-3` / `oauth:anthropic:ufuk2` | First seed request | 429, `rate_limit_error` | `req_011CfgNGeY7Za3USQtHuKEST` | All absent (`usage:null`) | No `input_transformations` or equivalent diagnostic in the error response |

The refresh field was subsequently filled with an inert **non-secret** placeholder;
no real refresh token was requested, copied or used by the harness/plugin. The
vault serves access bearers and owns any upstream refresh. Background plugin
refresh, fallback accounts, keep-warm, dumps and relay were disabled. Credentials
were read only through `mc-e2e`. Two initial schema/classification checks read each
route's access material in memory (values never printed); the live attempts read
one selected account per run. There was no account-roster loop.

**Total live model HTTP calls: 2, both rejected. Provider-reported tokens spent:
0 reported; actual charged tokens are unknown because both errors omitted usage.**
No generated output tokens were observed. Do not infer a priced invoice or input
token count from the request's byte size. The startup-only attempt cost zero model
calls. The first 429 caused the installed subscription plugin to wait despite the
recorder halting upstream; the host API timed out. The recorder now records the
upstream error and returns a local non-retryable 400. The alternate attempt stopped
promptly (one later retry was refused locally, not forwarded).

## Isolation and credential deletion

`lsof -p` sampled each host and passed its database fence:

| Run | Host PID | Sampled open database paths (relative to disposable root) | Root removed |
| --- | --- | --- | --- |
| `live-1` | 82638 | `data/opencode/live.db{,-wal,-shm}`, `data/cortexkit/magic-context/context.db{,-wal,-shm}` | yes |
| `live-2` | 84513 | Same disposable OpenCode and MC paths | yes |
| `live-3` | 1210 | Same paths; also disposable `home/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/onnxruntime.db{,-wal,-shm}` | yes |

The absolute parent was
`/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_2e0efd96/`;
each root was `live-N/roots/claude-oauth_trim-only`. macOS lsof canonicalized the
paths with `/private/var/...`. No sampled DB path lay outside its root. HOME,
XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR,
OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR, child TMPDIR and working directory were
inside that root. This is sampled host isolation, not continuous auditing of
all descendants or outbound metadata requests.

**All three throwaway credential configs/login slots and generated auth state were
deleted with their roots after the hosts stopped.** Only scrubbed host/MC logs and
reduced results remain in the temporary output directories. No credential or raw
signed-thinking text is committed. No live OpenCode/MC database or operator config
was read, written, migrated or cleaned up.

## Harness delivered and what to run next

- Removed Bedrock from scenario selection and enrollment requirements.
- Added Claude OAuth and Codex routes with installed OpenCode plugin dists by path,
  explicit disposable auth files, bearer-only slots and no operator-store fallback.
- Added Anthropic SSE usage merging, request caps/hashed history, request IDs and
  nested response transformation diagnostics. Added a conservative `trimOnly`
  qualification result so 200s cannot silently stand in for the requested edit.
- Added the real MC age/flush/cache/tool-drop session sequence. It is **not** a
  direct SDK or proxy-rewritten signed-history experiment. Its live mutation stages
  are unverified until a seed succeeds.
- Unit checks: 21 passed, 1 optional installed-dist check skipped by default.
  Explicit installed-dist smoke: 7 passed, both Claude and Codex reached a loopback
  model recorder with fake tokens in disposable hosts; this is **not** live Codex
  acceptance. Scoped harness TypeScript 5.9.3 check passed. The whole e2e project's
  typecheck has unrelated pre-existing errors; the scoped config excludes them.
- Non-vacuity: neutralizing the lsof path fence failed exactly
  `disposable subscription auth > lsof isolation rejects missing, external and prefix-lookalike database handles`;
  the other five auth unit tests passed, the optional smoke was skipped, and the
  fence was restored before verification/commit.

Next action: after quota becomes available, run the documented
`claude-oauth:trim-only` command on **one** explicitly selected enrolled account.
Inspect `trimOnly.qualified`, each request/usage record, and response diagnostics.
If MC makes another earlier edit on the purported trim-only pass, qualification
must remain false; do not count acceptance with stripped later thinking as the
requested trim-only evidence. The request's strict binding control and the
following cache read must both be observed before updating the pending rows in
[`reasoning-cleanup-per-provider.md`](reasoning-cleanup-per-provider.md).
