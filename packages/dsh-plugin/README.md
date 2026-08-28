# @cortexkit/dsh-magic-context

Magic Context for DeepSeek Harness (DSH) — keep long sessions inside the context window without losing history.

A persistent DSH plugin (Host / Agent / Client + profile bundle) that shares the Magic Context SQLite (`harness='dsh'` row isolation) and brings `ctx_*` tools, `/ctx-*` commands, knowledge injection (m0/m1), historian/dreamer, and the Magic compaction policy to DSH.

> Single-package port inside the [cortexkit/magic-context](https://github.com/cortexkit/magic-context) monorepo (MIT).  
> **Credit:** original community port by [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context) — this package is a direct continuation with `adapter-api` merged into one package and `harness='dsh'` support upstreamed.

- **Shared store.** One SQLite at `~/.local/share/cortexkit/magic-context/context.db`, `harness='dsh'` isolated — works alongside OpenCode (`opencode`) and Pi (`pi`) without extra DB.
- **Full Magic Context surface.** `ctx_reduce` / `ctx_expand` / `ctx_memory` / `ctx_search` / `ctx_note`, `/ctx-status` / `/ctx-recomp` / `/ctx-wrapup` / `/ctx-embed`, auto-search, `§N§` tags, decay rendering, smart-drops.
- **DSH-native.** Host (`cordis` bundle), Agent (preset `magic-standard`), Client (status card) — thin preset, `link:`-friendly for local dev.

```sh
# from a DSH profile (e.g. web = prod, mc = dev)
dsh plugin --profile web install link:/path/to/magic-context/packages/dsh-plugin
dsh-magic-context setup --profile web   # generates magic-standard preset
dsh-magic-context doctor --profile web  # 5/5 ok (liveness warn is harmless)
# then restart DSH and select magic-standard preset
```

## Install

**Production (published):**

```json
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@cortexkit/dsh-magic-context": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@cortexkit/dsh-magic-context"] } }
}
```

```sh
dsh plugin --profile <name> install
dsh-magic-context setup --profile <name>
dsh-magic-context doctor --profile <name>
```

**Local dev (monorepo):**

```sh
# inside magic-context monorepo
bun run --cwd packages/dsh-plugin build
dsh plugin --profile <name> install link:/absolute/path/to/magic-context/packages/dsh-plugin
dsh-magic-context setup --profile <name>
# global preset now points at file:///…/magic-context/packages/dsh-plugin/dist/entries/*
# both profiles share the same file:// — no per-profile drift
```

Restart DSH and select `magic-standard` for new sessions. First session creates the shared SQLite if missing.

## Features

- **Knowledge.** m0/m1 baseline injection (project docs + memories), auto-search, `§N§` tag hygiene with Channel-1/2 nudges
- **Context.** DSH transcript + surface CAS (outbox saga), historian compartments (tiered decay), Magic compaction policy
- **Automation.** Dreamer tasks, `/ctx-recomp` / `/ctx-wrapup` / `/ctx-session-upgrade`, `/ctx-embed`, feedback bridge
- **Web.** Sidebar card + Remote diagnostics via `src/client/client.js` (`__ModuleLoader__` id `@cortexkit/dsh-magic-context`)

Full feature table and constraints: see repository `README.md` and `ARCHITECTURE.md`.

## Uninstall

```sh
dsh plugin --profile <name> remove @cortexkit/dsh-magic-context
```

Remove the `bundles` entry and restart DSH. Shared SQLite and `dsh_*` adapter rows are intentionally preserved (cross-harness data); remove `~/.dsh/.agent-presets/magic-standard/` manually if unneeded.

## Compatibility

- DSH `0.1.1-rc.2` exact-rc (run `doctor` contract gate before upgrading)
- Magic Context shared schema `v81` (this package's `LATEST_SUPPORTED_VERSION`)

## Credit

Original DSH port: [xiaohj233/dsh-magic-context](https://github.com/xiaohj233/dsh-magic-context). This package continues that work inside the upstream monorepo; upstream issues and PRs belong at [cortexkit/magic-context](https://github.com/cortexkit/magic-context).

## License

MIT. Upstream copyright notices: see `THIRD_PARTY_NOTICES.md`.
