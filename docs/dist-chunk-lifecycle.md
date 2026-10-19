# Development plugin distributions and running hosts

Pi and OpenCode can load Magic Context directly from a checkout's `dist/` and
remain running across rebuilds. The entry module is already in memory, but lazy
imports still resolve its old content-hashed filenames on disk. An unreferenced
chunk is therefore not necessarily unused: the reference can live in a running
process rather than any current file.

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
