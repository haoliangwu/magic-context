# Dashboard v0.9.0

Adds a browser mode so the dashboard works on Linux and WSL2 setups where the desktop window comes up blank, and recognizes OpenCode Desktop installs that have no CLI.

## Features

- **Browser mode (`--serve`).** On some Linux distributions and under WSL2 the desktop window opens blank (often with `Could not create default EGL display`) because the bundled WebView cannot start against the host's graphics stack. The same binary can now run as a local web server instead: `magic-context-dashboard --serve` prints a URL (with a one-time access token) that you open in your normal browser, bypassing the embedded WebView entirely. It binds `127.0.0.1:9077` by default; `--serve <port>` changes the port, and `--host 0.0.0.0 --allow-remote` exposes it to other machines (off by default, behind an explicit flag, since the dashboard can read transcripts and edit config). See the [dashboard docs](https://docs.cortexkit.io/magic-context/reference/dashboard/#browser-mode---serve).

## Fixes

- **Recognizes OpenCode Desktop installs without a CLI (#196).** Installing OpenCode only through the Desktop app leaves no `opencode` binary to query, so model dropdowns came up empty with no explanation. The dashboard now detects a Desktop-only install and lets you type a model id manually, with a hint explaining why auto-population is unavailable. A stock CLI installed outside PATH is also found and used.

## Maintenance

- Pre-release hardening: `--serve` API responses are marked `no-store`, and Desktop detection has more robust path fallbacks when environment variables are unset.
