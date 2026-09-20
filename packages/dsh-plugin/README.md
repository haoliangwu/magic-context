# @cortexkit/dsh-magic-context

Magic Context for DeepSeek Harness (DSH) — keep long coding sessions inside the context window without losing history. Sessions that would blow the window keep running, with everything the model has learned still reachable: durable memories, compartment summaries, and searchable raw history.

It installs as a native DSH plugin and works on **every agent preset** — no preset-specific setup. `ctx_*` tools, `/ctx-*` commands, knowledge injection, historian/dreamer, and the Magic compaction policy mount host-wide.

> Single-package port inside the [cortexkit/magic-context](https://github.com/cortexkit/magic-context) monorepo (MIT).  
> **Credit:** original community port by [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context) — this package is a direct continuation with `adapter-api` merged into one package and `harness='dsh'` support upstreamed.

- **Shared store.** One SQLite at `~/.local/share/cortexkit/magic-context/context.db`, `harness='dsh'` isolated — works alongside OpenCode and Pi with no extra DB, and cross-harness memories just work.
- **Full Magic Context surface.** `ctx_reduce` / `ctx_expand` / `ctx_memory` / `ctx_search` / `ctx_note`, `/ctx-status` / `/ctx-recomp` / `/ctx-wrapup` / `/ctx-embed`, auto-search, `§N§` tags, decay rendering, smart-drops.
- **DSH-native, zero-config mounting.** Host (`cordis` bundle) + agent plane (host-row, every preset) + client (status card). The boot-time self-heal patches the compaction row of the **shipped** presets in place (ADR 0001) — restart DSH and it is mounted.

```sh
# from a DSH profile (e.g. web = prod, mc = dev)
dsh plugin --profile web install link:/path/to/magic-context/packages/dsh-plugin
# restart DSH — every preset gets the Magic surface; the status panel's
# "preset" row shows "patched 3/3" when the shipped presets are patched
```

## Install

**Production — npm (when published):**

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

```sh
dsh plugin --profile <name> install
dsh-magic-context doctor --profile <name>
```

**Production — GitHub subpath (no npm publish, verified with pnpm 11):**

Pin to a commit SHA for reproducibility, or track the branch (the plugin
version follows the monorepo version — `0.42.6` in lockstep with
`@cortexkit/opencode-magic-context`; fork release tags use that scheme
once cut):

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "github:haoliangwu/magic-context#master&path:packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

The `prepare` script runs `bun run build` automatically on install. If pnpm blocks it (git-hosted `prepare` needs allowlisting), add the tarball key to `pnpm-workspace.yaml`:

```yaml
# ~/.dsh/profiles/<name>/pnpm-workspace.yaml
allowBuilds:
  'tar.gz/<sha>#path:packages/dsh-plugin': true
```

The exact key is printed by pnpm in `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` — copy it verbatim. See Q&A below.

```sh
dsh plugin --profile <name> install
dsh-magic-context doctor --profile <name>
```

> Verified: `pnpm add "@cortexkit/dsh-magic-context@github:haoliangwu/magic-context#master&path:packages/dsh-plugin"` resolves. `prepare` runs `bun run build`; if `bun` is not in the profile env, run `bun --cwd …/node_modules/@cortexkit/dsh-magic-context run build` manually.

**Local dev (monorepo):**

```sh
# inside magic-context monorepo
bun run --cwd packages/dsh-plugin build
dsh plugin --profile <name> install link:/absolute/path/to/magic-context/packages/dsh-plugin
# restart the host: the boot-time self-heal (ADR 0001) resolves
# @deepseek-ai/dsh-agent-presets from THIS package's module context and patches
# the shipped compaction-basic rows to file://…/dist/entries/compaction.js
# (tmp+rename atomic writes; pnpm hardlinks are never written in place)
```

Restart DSH — every preset now mounts the Magic surface host-wide, and the
shipped presets' compaction rows point at `file://…/magic-context/packages/dsh-plugin/dist/entries/compaction.js`. First session creates the shared SQLite if missing. `setup` is a report-only alias of `doctor`.

## Features

- **Knowledge.** m0/m1 baseline injection (project docs + memories), auto-search, `§N§` tag hygiene with Channel-1/2 nudges
- **Context.** DSH transcript + surface CAS (outbox saga), historian compartments (tiered decay), Magic compaction policy
- **Automation.** Dreamer tasks, `/ctx-recomp` / `/ctx-wrapup` / `/ctx-session-upgrade`, `/ctx-embed`, feedback bridge
- **Web.** Sidebar card + Remote diagnostics via `src/client/client.tsx` → `dist/client.js` (`__ModuleLoader__` id `@cortexkit/dsh-magic-context`)

Full feature table and constraints: see repository `README.md` and `ARCHITECTURE.md`.

## Uninstall

```sh
dsh plugin --profile <name> remove @cortexkit/dsh-magic-context
```

Remove the `bundles` entry and restart DSH. Shared SQLite and `dsh_*` adapter rows are intentionally preserved (cross-harness data); any legacy `~/.dsh/.agent-presets/magic-standard/` thin preset is shape-verified and removed by the boot self-heal. Removing the package leaves the patched shipped-preset rows pointing at a missing path until the preset files rotate (ADR 0001 — accepted for single-user deploys; `doctor` reports the state).

## Compatibility

- DSH `0.1.5-rc.2` (run `doctor` contract gate before upgrading; the boot heal's anchor chain fail-opens on layout changes)
- Magic Context shared schema `v85` (this package's `LATEST_SUPPORTED_VERSION`)

## Q&A

**Q: pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 怎么办?**

pnpm 默认禁止 git-hosted 依赖的 `prepare` 脚本。把报错里打印的 tarball key 加到 profile 的 `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  'tar.gz/<hash>#path:packages/dsh-plugin': true
```

key 必须和报错信息里的完全一致。`github:...` 和 `git+https://...` 两种 spec 形式会被 pnpm 归一化到同一个 codeload tarball key,所以哪种写法都行。

**Q: I use Pi / OpenCode and DSH together and want to share memories. Do versions need to match?**

Yes — all harnesses share one SQLite at `~/.local/share/cortexkit/magic-context/context.db`. The DB is versioned (`schema v85` at `LATEST_SUPPORTED_VERSION`); a newer plugin migrates the DB forward, an older one will fail the schema fence and refuse to open it. If you share memories across `pi` / `opencode` / `dsh`, keep their `@cortexkit/*-magic-context` versions in sync (same monorepo tag) so they agree on the schema. `doctor` reports the schema version and the adapter ceiling.

**Q: What happens on a version mismatch?**

The older harness fails closed (loud error, no silent fallback) until you upgrade it. The DB itself is not corrupted — upgrading the lagging plugin re-opens it after migration.

## Credit

Original DSH port: [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context). This package continues that work inside the upstream monorepo; upstream issues and PRs belong at [cortexkit/magic-context](https://github.com/cortexkit/magic-context).

## License

MIT. Upstream copyright notices: see `THIRD_PARTY_NOTICES.md`.
