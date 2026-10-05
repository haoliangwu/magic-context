# Development plugin distributions and running hosts

Pi and OpenCode can load Magic Context directly from a checkout's `dist/` and
remain running across rebuilds. The entry module is already in memory, but lazy
imports still resolve its old content-hashed filenames on disk. An unreferenced
chunk is therefore not necessarily unused: the reference can live in a running
process rather than any current file.

## Deletion audit

The week-long policy introduced in `6cf65d53935842af4cdbac66ddd0928eeea108fa`
changed the build cleaner, not every distribution writer. Two destructive paths
remained:

* `scripts/restart-window.sh` copied both distributions with `rsync -a --delete`.
  That deletes every destination-only chunk, regardless of age. Copying a
  prebuilt checkout containing two generations over a checkout with a third
  generation leaves precisely two generations with the source mtimes, because
  `-a` preserves timestamps. This bypassed the new retention policy. The script
  asks operators to close hosts, but store-holder preflight cannot prove that
  every process with an in-memory module has exited.
* Both package `clean` scripts used `rm -rf dist`. Calling `clean` before a build
  also bypassed retention, including OpenCode's `dist/v2`.

These are reproduced against throwaway distributions by
`package clean preserves chunks needed by running hosts` and
`restart-window merges distributions without deleting a running generation` in
`packages/plugin/scripts/clean-dist-chunks.test.ts`. Both failed on the old
commands with ENOENT for the recent `index-running.js`. The restart test executes
the actual dist-copy block, not the migration or deployment script as a whole.

The restart script now age-prunes the destination **before** merging without
`--delete`; pruning after copying could delete a current incoming chunk whose
prebuilt mtime is old. Package `clean` now removes named entry points and expired
chunks through the same cleaner, retaining recent chunks. It is intentionally
no longer a recursive removal of the distribution.

The remaining writers/readers were checked as follows:

| Path | Effect on existing chunks |
| --- | --- |
| Root `build`, `build:dists`; either plugin's `build`/`prepublishOnly`; OpenCode `build:v2` | Run the week-based cleaner before Bun writes entry points and hashed chunks. No directory replacement. |
| Bun CLI `build --outdir`, Bun API `Bun.build({ outdir })` | Overwrite matching outputs, **do not empty the output directory**. The regression builds three changing split generations into one throwaway dist (CLI twice, API once) and checks the first generation's bytes survive. Observed with Bun 1.4.2. |
| Browser transformers `--outfile`; `build-transformers-node-wasm.ts` | Write the named transformers entry, not a directory replacement. The latter uses Bun's API. |
| OpenCode `build:tui`, declaration emit | Write `src/tui-compiled` and declaration files; no hashed-JS pruning. |
| `dists:load-probe` | Import-only. It neither builds nor cleans. |
| `scripts/place-ck-mc.sh` | Replaces the ck-mc binary and its staging metadata, not either plugin dist. |
| `scripts/release.sh`, release/CI workflows | Invoke the package builds; no separate dist purge or git-clean step found. Packing/audit uses temporary consumer roots. |
| `scripts/release-e2e-docker.sh` | Copies a read-only checkout into container tmpfs; optional missing-dist builds are in that copy. |
| e2e mutation builder `run-rust-fm-mutation.ts` | Invokes the regular OpenCode package build, inheriting retention. |
| e2e `Bun.build` probes (including contention, storage readiness, hidden-child, marker and output-cap probes) | Build into test-owned temporary roots, then remove those roots, not package dist. |
| e2e OpenCode/Pi runners | Read an existing dist/source entry; Pi links the package into its isolated extension directory. They do not delete/rebuild the package dist. |
| Package tests that bundle (Pi write contention, SSRF parity, transformers runtime) | Build into test-owned temp directories, not the package dist. |
| `scripts/drive-rig/prepare.sh` | Copies an existing dist into its snapshot, not back into the checkout. |

No tracked automation using `git clean`, `mv`/rename of a plugin dist directory,
or another recursive plugin-dist deletion was found. A manual `git clean -xfd`
or manual removal of an ignored dist can still delete chunks; it is not a safe
deployment operation while hosts are running.

The missing `index-72g30tgz.js` and the two surviving mtime generations are
consistent with the destructive rsync path, not with a same-day age-based prune
or Bun clearing `--outdir`. This audit proves the deletion mechanisms and fixes
them; it does not establish which command was actually invoked on October 3.
That requires an incident deployment/shell log, not filesystem mtimes alone.
No live stores or the operator's checkout were inspected or modified.

## Recovery when a chunk has already disappeared

Internal lazy imports are guarded, and shared catch-path logging recognizes
missing-module errors only when the missing path resolves inside the loaded
plugin's own `dist/`. Node's `Cannot find module` and Bun's `ENOENT reading`
variants, relative imports and file URLs are supported. Missing dependencies,
other packages' distributions and ordinary file/network errors are not relabeled.

One process-wide warning asks Pi users to type `/reload`, or OpenCode users to
restart their host. OpenCode 2 queues it through Magic Context's TUI RPC channel.
Each distinct missing chunk gets one single-line diagnostic; retries of that
same import, nested catch logging and additional plugin instances do not repeat
it. State survives module reloads through a process-global symbol.

A missing QuickJS lazy chunk cancels the smart-note check as unavailable plugin
infrastructure. It is not a bad note condition: due checks leave the note
pending, and dry-run compilation does not increment condition failure counts,
ask for a rewrite or switch to fallback evaluation because of the stale build.
