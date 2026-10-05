# OpenCode Zen free-tier gate probe (2026-09-22)

## Result

OpenCode Zen's free-model gate does **not** distinguish Magic Context's hidden historian by a missing OpenCode header, by the child-session API, by the custom system prompt, by request size, or by the logging proxy. It distinguishes the provider request by its **tool definitions**.

On OpenCode 1.18.30, the smallest accepted tool surface measured here was the real OpenCode `bash` and `read` definitions plus the `task` tool that OpenCode includes for these child agents. `read` + `task` returned 403, `bash` + `task` returned 403, and `bash` + `read` + `task` returned 200. Magic Context's historian deliberately allows `read` but denies `bash`, so OpenCode filters `bash` out before sending the provider request. Zen then returns:

```text
Error from provider (Console): OpenCode's free tier can only be used from within OpenCode
```

Adding a user override of `historian.permission.bash = "ask"` made the historian request contain `bash`, `read`, and `task`; the same custom historian system prompt then succeeded with 200. This is useful as a diagnostic workaround, but it is not a safe default product fix: a hidden child cannot interactively approve a shell request, and changing the built-in allow-list to `allow` would give a summarizer shell access.

No product code was changed by this probe.

## Scope and version caveat

The installed harness binary was:

```text
/Users/ufukaltinok/.opencode/bin/opencode
OpenCode 1.18.30
Mach-O 64-bit executable arm64
```

The 1.18.30 catalog no longer exposes `opencode/mimo-v2.5-free`. An attempted arm using that exact ID stopped before any provider request with `Model not found` and suggested current models including `mimo-v2.6-flash-free`. All network measurements below therefore use `opencode/mimo-v2.6-flash-free`, which reproduced the issue's exact `FreeTierError`. This establishes the gate for the current Zen free-model class, not continued availability of the older model ID.

The isolated Mason worktree did not contain the gitignored `packages/plugin/dist` output. `bun install --frozen-lockfile` reported no dependency changes, then the current source was built with `bun run build` in `packages/plugin`; the probe loaded that generated `packages/plugin/dist/index.js`. No generated output is committed.

## Isolation and authentication

Everything writable was rooted under:

```text
$TMPDIR/magic-context/zen-probe/
```

The host was launched with:

```text
OPENCODE_CONFIG_DIR=$ROOT/config
XDG_CONFIG_HOME=$ROOT/config
XDG_DATA_HOME=$ROOT/data
XDG_STATE_HOME=$ROOT/state
XDG_CACHE_HOME=$ROOT/cache
OPENCODE_DB=$ROOT/data/opencode/opencode.db
MAGIC_CONTEXT_STORAGE_DIR=$ROOT/storage
MAGIC_CONTEXT_LOG_PATH=$ROOT/logs/magic-context.log
```

`~/.local/share/opencode/auth.json` had no `opencode` entry, so nothing was copied. The probe was anonymous. OpenCode still supplied its built-in public bearer credential; captures redact `authorization` after the first eight characters (`Bearer p<redacted>`).

The final `lsof -nP -p 62497` proof recorded 22 handles under the throwaway root, including:

```text
.../zen-probe/work
.../zen-probe/data/opencode/opencode.db{-wal,-shm}
.../zen-probe/data/opencode/log/opencode.log
.../zen-probe/storage/context.db{-wal,-shm}
```

It recorded zero handles under the live OpenCode data, config, state, or Desktop stores (`~/.local/share/opencode`, `~/.config/opencode`, `~/.local/state/opencode`, and the Desktop application-support store).

## What OpenCode 1.18.30 builds

`strings -a` over the installed 147 MB binary exposed the bundled, minified JavaScript. The provider catalog declares:

```js
opencode: {
  id: "opencode",
  npm: "@ai-sdk/openai-compatible",
  api: "https://opencode.ai/zen/v1",
  name: "OpenCode Zen"
}
```

The request-preparation path constructs these headers for provider IDs beginning with `opencode`:

```js
{
  ...(projectID ? { "x-opencode-project": projectID } : {}),
  "x-opencode-session": sessionID,
  "x-opencode-request": userMessageID,
  "x-opencode-client": flags.client,
  "User-Agent": `opencode/${version}`,
  ...(parentSessionID ? { "x-parent-session-id": parentSessionID } : {})
}
```

No per-request signature or attestation was found around this path. The provider body had no `client`, `agent`, `mode`, `user`, or `metadata` top-level field in any measured arm. Session, request, project, client, version, and parent identity were carried in headers.

The loopback proxy forwarded to `https://opencode.ai/zen/v1` and returned status, headers, and body bytes unchanged. A normal free-model turn and multiple controls succeeded through it, so TLS/SNI or direct-origin enforcement was not the gate.

## Three requested arms

The comparable provider request in every arm used `POST /chat/completions`, `model: "mimo-v2.6-flash-free"`, streaming, and the same OpenCode identity headers.

| Field | (a) `opencode run` | (b) Magic Context historian | (c) plain host-client child |
|---|---|---|---|
| Result | 200, output `OK` | 403 `FreeTierError`, no assistant output | 200, output `CHILD_OK` |
| `user-agent` | `opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.2` | same | same |
| `x-opencode-client` | `cli` | `cli` | `cli` |
| `x-opencode-project` | `global` | `global` | `global` |
| `x-opencode-session` | `ses_f37...<redacted>` | `ses_f37...<redacted>` | `ses_f37...<redacted>` |
| `x-opencode-request` | `msg_0c84...<redacted>` | `msg_0c84...<redacted>` | `msg_0c85...<redacted>` |
| `x-parent-session-id` | absent (primary) | present | present |
| Body top-level keys | `max_tokens,messages,model,stream,stream_options,tool_choice,tools` | same | same |
| System prompt | standard OpenCode/Magic Context primary prompt | Magic Context Historian prompt | standard OpenCode/Magic Context child prompt |
| Provider-visible tools | normal OpenCode tool surface, including `bash` and `read` | initially `task`; default historian control was `read,task` | normal OpenCode tool surface, including `bash` and `read` |

Arm (a) also made a title-generation request. Both it and the main request carried `x-opencode-client: cli` and succeeded. This proves that headless `opencode run`, not just the interactive TUI, passes the free-tier gate.

Arm (b) was forced on a third turn. The first parent turn carried 241,646 characters of varied ballast and ended at 23.9% measured context pressure; the second remained just below the unsummarized-tail budget; a 40,060-character third turn made the historian fire. Its child request had the historian system marker, `x-parent-session-id`, and all the same OpenCode identity headers, but Zen returned 403 in about two seconds. The parent turn itself continued and succeeded.

Arm (c) used `client.session.create({ parentID })` and `client.session.promptAsync(...)`, without the historian agent or prompt. It returned `CHILD_OK`. Its child header shape, including `x-parent-session-id`, was the same as the historian's, which rules out the child-session transport itself.

## Discriminator controls

All controls below were generated by OpenCode itself and passed through the same proxy. Status is Zen's response status.

| System/agent | Provider-visible tools | Status | What it establishes |
|---|---|---:|---|
| Standard `build` child | full normal set including `bash,read` | 200 | Bare children are allowed. |
| Historian, tiny 42-character prompt | `task` | 403 | Not request size or historian workload. |
| Historian, default tool policy | `read,task` | 403 | Reproduces the normal Magic Context policy. |
| Standard `build` child | `task` | 403 | The historian system prompt is not required to fail. |
| Standard `build` child | `read,task` | 403 | The default historian tool surface is enough to fail with the standard prompt. |
| Standard `build` child | `bash,task` | 403 | `bash` alone is not sufficient. |
| Standard `build` child | `bash,read,task` | 200 | `bash` added to the historian shape is sufficient. |
| Standard `build` child | `bash,glob,grep,read,task` | 200 | Mutating `edit`/`write` tools are not required. |
| Standard `build` child | `edit,glob,grep,read,task,write` (no `bash`) | 403 | A broad tool set without `bash` still fails. |
| Arbitrary custom `probe-custom` system prompt | full normal set including `bash,read` | 200 | Custom agent name/system text is allowed. |
| Actual Historian with `permission.bash = "ask"` | `bash,read,task` | 200 | Smallest measured Magic Context-side change clears the gate. |

The last control kept the 63,374-character Historian system prompt unchanged and returned `HISTORIAN_BASH_ASK_OK`. Conversely, the standard OpenCode system prompt failed when its tools were reduced. The discriminating provider field is therefore the `tools` array, not `agent`, `mode`, system-prompt identity, header identity, or request size. More precisely, for the actual historian shape, the missing real OpenCode `bash` definition is decisive: the existing `read,task` request fails and `bash,read,task` passes. The probe did not test whether a forged tool name without OpenCode's schema would pass.

## Why Magic Context hits it

Magic Context intentionally builds its hidden historian with a deny-by-default permission map. `packages/plugin/src/agents/permissions.ts` documents that Historian may use `read` and read-only AFT navigation tools but must not use `bash`, `edit`, or `write`; its built-in allow-list is:

```ts
["read", "aft_outline", "aft_zoom", "aft_search"]
```

Only `read` was registered in this host, and OpenCode also supplied `task`, yielding the rejected `read,task` provider request. OpenCode's normal child inherits the regular tool surface and therefore includes the real `bash` and `read` definitions, yielding an accepted request. No plugin code strips an OpenCode origin header; the permission filter removes the tool signature Zen currently treats as proof of OpenCode use.

## Fix and workaround assessment

The smallest measured configuration workaround is:

```jsonc
{
  "historian": {
    "permission": {
      "bash": "ask"
    },
    "opencode": {
      "model": "opencode/mimo-v2.6-flash-free"
    }
  }
}
```

That changes the provider-visible tools from `read,task` to `bash,read,task` and changed the result from 403 to 200. It is not recommended as a silent default: `allow` violates Historian's read-only design, while `ask` can leave a hidden run unable to resolve an approval if the model calls `bash`.

The preferable fix is in Zen's gate: accept requests carrying OpenCode's own `x-opencode-client`, `x-opencode-project`, `x-opencode-session`, `x-opencode-request`, versioned user-agent, and (for children) `x-parent-session-id` without requiring a mutable tool surface. If the server needs stronger anti-spoofing, OpenCode and Zen should add a real host attestation rather than infer origin from tool availability. Until then, Magic Context can document the `bash: "ask"` diagnostic workaround or recommend a non-free/BYOK historian model; shipping shell access in the default historian allow-list would be the wrong one-line fix.

## Plain-English GitHub reply

OpenCode is sending the same origin headers for the normal turn, Magic Context's historian child, and a plain child session (`x-opencode-client: cli`, the OpenCode version user-agent, project/session/request IDs, and the parent-session ID for both children). A normal `opencode run` and a plain SDK-created child both work through a logging proxy, while the historian gets the reported 403. The difference is the provider-visible tool list: Magic Context intentionally makes Historian read-only, so its request contains `read` and `task` but not OpenCode's `bash` tool. Zen currently treats that reduced tool surface as “not within OpenCode.” A tiny Historian request still fails, a custom-system child with normal tools succeeds, and adding `bash: "ask"` to the historian permission makes the unchanged Historian prompt succeed. So this is not a missing child-session header; it is Zen using tool availability as its OpenCode-origin signal.
