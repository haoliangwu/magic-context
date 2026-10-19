# Dashboard v0.5.2

A small patch release: edit user memories directly from the dashboard, and the Config editor catches up with the current plugin schema.

## What's New

- **Edit, expand, and delete user memories from the User Memories panel.** Promoted memories and pending candidates now show their full content instead of a truncated one-line preview, and each memory has an inline editor (Save / Cancel) so you can fix wording without touching the database. Editing a memory refreshes a running session's profile, so the change takes effect on its next turn. The Delete button now asks for a second click to confirm before removing anything.

## What's Fixed

- **The Config editor matches the current plugin schema again.** The settings form had drifted from the plugin: it still wrote the retired `experimental.*` keys for temporal awareness, auto-search, git-commit indexing, and caveman compression — which had graduated to top-level / `memory.*` in v0.22.0 — so toggling any of them in the dashboard quietly re-introduced the dead namespace and fought the plugin's own config migration. Those four now map to their real locations under a renamed **History & Recall** section, and a new **Advanced** section exposes settings that previously had no control at all: `auto_update`, `keep_subagents`, `system_prompt_injection`, and the `sqlite` cache/mmap tuning.

- **Correct schema URL and setup command in generated configs.** A freshly generated config pointed its `$schema` at the old pre-rename repository path and suggested an outdated setup command. Both now use the current `cortexkit/magic-context` repository and the unified `npx @cortexkit/magic-context setup`.
