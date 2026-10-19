# Dashboard v0.8.0

A major dashboard release that reorganizes everything around your **projects**, ships the full **Dreamer V2** control surface, adds **Primers**, and brings the config and embedding changes from plugin v0.27.0 to the desktop app.

## Project-centric navigation

The dashboard is now organized around projects instead of scattered global lists. The sidebar is **Projects, Workspaces, Cache, User Directives, Config, Logs**.

- **Projects** is a searchable card grid sorted by recent activity. Each card shows session and memory counts, the workspace it belongs to (if any), active harness badges (OpenCode / Pi), and when it was last active.
- Open a project to get **Sessions, Memories, Dreamer, and Primers** as tabs scoped to that project. The old global Memories, Sessions, Dreamer, and Primers pages are gone; you reach each through its project, so you are always looking at one project's data with no cross-project noise.

## Dreamer V2 control surface

The Dreamer page is rebuilt for the new per-task model (plugin v0.27.0):

- A **project-card grid** with a collapsible task list per project, each task showing its schedule and a last-run traffic light (hover for detail).
- **Per-project configuration** via a gear button: edit a project's dreamer tasks in a focused modal that writes a per-project override, with a clear "inherited from global" indicator and a one-click revert.
- A redesigned **task list as cards** with inline icons and on/off toggles, an error panel when a run fails, and a flat run-history table (started, task, status, duration, tokens, memory changes).
- A **cron picker** that actually works: presets (nightly, weekly, hourly), a custom-cron escape hatch with validation, and a human-readable explanation ("Every day at 3am").

## New: Primers

A **Primers** tab surfaces each project's durable standing answers (the recurring "how does X work?" questions the dreamer keeps current by reading the code), with their freshness.

## Memory classification

The Memory browser now shows each memory's **importance** (as a band-colored pill) plus scope and shareability when they differ from the defaults, so you can see at a glance what the dreamer considers load-bearing.

## Workspaces: selective memory sharing

The Workspaces panel lets you share memory **by category** across member projects (toggle which of the five categories cross over, defaulting to `CONSTRAINTS` only), with a staged Save / Discard so a batch of changes commits as one.

## Cache Diagnostics improvements

- The **Cache Hit Timeline** scales each bar to the model's context window and segments by context-window changes, so a 1M-token model and a 256k model are never measured against the same axis.
- A redesigned, provider-agnostic **cache health** metric (no longer relying on cache-write data only some providers report), with an explicit UNKNOWN state for providers that report no cache accounting.
- The per-session view colors the compartment strip by **importance** instead of an arbitrary rainbow.
- Fixes a case where the timeline fragmented into one segment per step for sessions without a recorded context limit (e.g. background subagents); these now render on one stable scale.

## Configuration moves to the CortexKit location

Matching plugin v0.27.0, the dashboard reads configuration from the shared CortexKit location (`~/.config/cortexkit/` and `<project>/.cortexkit/`). The OpenCode and Pi config tabs are collapsed into a single **User Config** tab. Edits preserve your comments and untouched keys (the editor aborts a save rather than dropping them on a parse error), and config writes are hardened against symlink and path-escape attacks.

## Reliability and correctness

- **Archived OpenCode sessions** no longer appear in session lists or inflate project session counts.
- **Deleted worktree projects** (leftover `bg_<hash>` directories from background tasks) no longer show up as their own project cards.
- `dir:<hash>` projects now resolve to their real directory name instead of an opaque hash.
- The dashboard **degrades gracefully** on older databases: it opens read-only, never creates or migrates tables, and falls back to sensible defaults when a column or table is missing rather than erroring.
- Robust memory-embedding queries for the new per-model embedding coexistence (plugin v0.27.0), and a fix for UTF-8 paths and string values in config parsing.
- Windows and version-manager (mise / asdf / volta) model-dropdown discovery via a login-shell PATH fallback.

## Upgrading

Download the build for your platform below. The dashboard is read-only against your Magic Context database, so it is safe to run alongside any plugin version; it degrades gracefully if your database predates plugin v0.27.0.
