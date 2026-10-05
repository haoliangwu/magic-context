# Issue 526: OMP role alias regression investigation

## Result

**Regressed on OMP.** The published Magic Context 0.43.2 Pi extension preserves
`historian.omp.model: "@historian"` and its real OMP child completes successfully.
The 0.44.0 baseline (`e0c06d9933c8f94b38597cae3c633c1f24a4b256`) drops the same
primary when given the real host registry. The patched extension preserves it.

Tested on 2026-09-28 with OMP 18.4.2, plain Pi 0.87.1, and Bun 1.4.2.
Both hosts **do pass `ctx.modelRegistry`**, including a `find` function. This is
not an unaffected, registry-absent path. Hosts that omit the registry skip this
validation and are unaffected by this particular regression.

Plain Pi does not resolve this OMP role syntax: 0.43.2 passes the alias to Pi,
which rejects it; 0.44.0 rejects it earlier. The fix deliberately leaves that
plain-Pi behavior unchanged.

## Method and isolation

The live run used the actual OMP and Pi CLIs, the full Magic Context extension,
and a diagnostic extension listening to `before_agent_start`. The diagnostic
extension passed the **real, unmodified** `ctx.modelRegistry` to the exported
`resolveHistorianFromConfig`. When a historian was returned, it called that
historian's production `runner.run` with `agent: "magic-context-historian"`, the
resolved model, a short summarization prompt, and a 15-second timeout.

This is a real historian **model-selection/subprocess smoke test**, not a test
of the token-pressure trigger or historian XML publication. The child called a
local OpenAI-compatible SSE server at `127.0.0.1:4019`; no model credentials or
paid provider requests were used. The mock server recorded `model: "mock-model"`.
There were no substitutions for the host registry, alias expansion, child
process, or production resolver/runner.

The 0.43.2 extension was obtained with `npm pack
@cortexkit/pi-magic-context@0.43.2` and extracted into the throwaway root. Its
published bundle was used unchanged (package tarball SHA-1:
`c3263fe1726b2111ca01c85db12af017a77b0f40`). Peer dependencies were supplied from
the worktree's Pi package. The baseline and patched 0.44.0 bundles were built
with `bun run --cwd packages/pi-plugin build`.

All host processes ran from throwaway project directories, with an explicit
fresh environment, not an inherited credential/config environment:

```text
HOME=<case>/home
XDG_CONFIG_HOME=<case>/config
XDG_DATA_HOME=<case>/data
XDG_CACHE_HOME=<case>/cache
XDG_STATE_HOME=<case>/state
MAGIC_CONTEXT_STORAGE_DIR=<case>/storage
PI_CODING_AGENT_DIR=<case>/agent
PATH=<isolated OMP bin>:<Bun bin>:<Node bin>:/usr/bin:/bin:/usr/sbin:/sbin
```

The root was `/tmp/mc526-live.wGrvoD`; each host/version had its own case
subdirectory. OMP 18.4.2 was installed locally there, without changing the
installed global OMP. No real home configuration or database was used.

OMP's `<case>/agent/config.yml` contained:

```yaml
modelRoles:
  historian: mock/mock-model
compaction:
  enabled: false
memory:
  backend: off
```

`<case>/agent/models.json` registered provider `mock`, API
`openai-completions`, model `mock-model`, the localhost base URL, a dummy API
key, a 128000-token context window and a 4096-token output limit.
`<case>/config/cortexkit/magic-context.jsonc` enabled Magic Context, set
`historian.omp.model` to `@historian` (the `pi` block for the plain Pi cases),
disabled dreamer and memory, set embedding provider to `off`, and disabled
updates. No role fallback was configured for the live smoke test.

The invocation shape was:

```text
<actual host CLI> --print --mode json --no-session \
  -e <case>/probe.mjs --model mock/mock-model "Say hello"
```

The diagnostic extension logged the context, resolved historian, spawn argv,
result, and `/usr/sbin/lsof -nP -p <pid>` for the parent and spawned child.
Raw artifacts, including the Python localhost server/driver and diagnostic
extensions, remain in `/tmp/mc526-live.wGrvoD` (`live.py`, each case's
`probe.mjs`, `evidence.log`, and `stdout.log`). These are temporary local
artifacts, not repository fixtures.

## Captured log evidence

OMP + 0.43.2:

```text
CONTEXT {"registry":"object","find":"function"}
HISTORIAN {"model":"@historian","fallbacks":[]}
RESULT {"ok":true,"assistantText":"Historian alias smoke completed.","toolCallCount":0,"durationMs":6740,"meta":{}}
```

The captured child argv includes `--model @historian`, not a concrete selector
substituted by Magic Context.

OMP + unpatched 0.44.0:

```text
CONTEXT {"registry":"object","find":"function"}
HISTORIAN {}
```

`HISTORIAN {}` is the diagnostic serialization of an undefined model and
fallback list: the resolver returned no historian, so no child was spawned.

OMP + patched 0.44.0:

```text
CONTEXT {"registry":"object","find":"function"}
HISTORIAN {"model":"@historian","fallbacks":[]}
RESULT {"ok":true,"assistantText":"Historian alias smoke completed.","toolCallCount":0,"durationMs":4546,"meta":{}}
```

Plain Pi + 0.43.2:

```text
CONTEXT {"registry":"object","find":"function"}
HISTORIAN {"model":"@historian","fallbacks":[]}
```

The result was `ok: false`, `reason: "non_zero_exit"`, exit code 1, with:

```text
Error: Model "@historian" not found. Use --list-models to see available models.
```

Plain Pi + both unpatched and patched 0.44.0:

```text
CONTEXT {"registry":"object","find":"function"}
HISTORIAN {}
```

### Open database evidence

Every captured SQLite pathname from `lsof` was checked to be under
`/private/tmp/mc526-live.wGrvoD/`. The OMP parents opened only these database
names under their own case directory (plus WAL/SHM companions):

```text
agent/agent.db
agent/models.db
home/.omp/cache/legacy-pi-extension-cache.db
storage/context.db
```

The successful OMP children were sampled while their HTTP request was pending;
they opened only their case's `agent/agent.db` and `agent/models.db`. Plain Pi
parents opened only their case's `storage/context.db`. No captured database
path pointed at the real CortexKit, OpenCode, Pi, or OMP state.

For example, patched OMP parent PID 90015 and child PID 90055 yielded these
`lsof` lines (columns omitted except PID, descriptor, and name):

```text
90015 24u /private/tmp/mc526-live.wGrvoD/omp-0440-fixed/storage/context.db
90055 13u /private/tmp/mc526-live.wGrvoD/omp-0440-fixed/agent/agent.db
90055 18u /private/tmp/mc526-live.wGrvoD/omp-0440-fixed/agent/models.db
```

## Fix boundary and remaining feature request

The validator now accepts an explicit harness and passes `@`-prefixed entries
through only for OMP. The exemption happens before the availability cache,
preventing cross-harness cache contamination. Unknown concrete `provider/id`
entries still go through `registry.find` and are dropped. Historian, scheduled
dreamer, manual dreamer, and model-chain warning callers supply their harness.

This does **not** implement issue 526's broader feature request:

- Configured `fallback_models: ["@cheap"]` entries are still removed upstream
  by `resolveFallbackEntries` / `isValidModelReference`. Tests explicitly keep
  that boundary. The validator test also covers alias entries already present
  in a runtime fallback chain; it does not teach the config resolver to create
  those entries.
- Full support needs an OMP-specific role-reference policy in the shared model
  parsing/resolution paths, preservation through the fallback attempt pipeline,
  tests for order/deduplication and per-attempt thinking levels, and explicit
  handling of unresolved aliases.
- Thinking-level precedence between a role selector suffix and MC's
  `thinking_level` needs a documented decision. This fix preserves existing
  qualifier behavior.
- OMP's own retry chains must not be silently merged into MC's fallback ladder;
  delegation versus MC-owned ordered attempts remains a separate design choice.
- The pre-existing chunk-budget warning about an alias lacking a provider prefix
  remains; this fix does not resolve aliases to infer context limits.

## Verification

Both new regression tests failed before the fix and passed after it. The full
Pi suite passed: 1316 passed, 3 skipped, 0 failed (1319 tests across 115 files).
The Pi package typecheck, lint, and bundle build passed. A deliberate temporary
alias-exemption mutation also failed the named validator regression test while
the empty-chain control passed; the mutation was restored before delivery.
