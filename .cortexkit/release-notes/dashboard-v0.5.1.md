# Dashboard v0.5.1

A small patch release.

## What's Fixed

- **No more console-window flashes on Windows.** Opening the dashboard spawned a child process for `git` (once per project while resolving identities) plus `opencode`/`pi` probes, each flashing a terminal window — easily a dozen or more on startup. All child spawns now use `CREATE_NO_WINDOW` on Windows (no-op on macOS/Linux). (#115)

## What's New

- **NVIDIA NIM support in Test Connection.** The embedding connection test now reads `input_type` / `truncate` from your config, so NIM endpoints can be validated from the dashboard. (#127)
