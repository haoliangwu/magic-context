# Dashboard v0.8.3

## Fixes

- **OpenCode model dropdowns no longer hide your configured providers.** Model discovery briefly used `opencode --pure models`, which skips external plugins and so omitted providers registered by auth plugins (e.g. `anthropic`, `google`). The pickers now use the full `opencode models` list, restoring every provider you have set up.
- **Wider model pickers.** The model selectors (and the "Add fallback model" dropdown in particular) were cramped and wrapped their options. They now fill the column.
- **Cleaner Cache Diagnostics.** Removed the combined "Show all" view: the page always focuses a single session's cache timeline instead of merging every session into one chart, which made the numbers confusing. A session is always selected; clicking a card focuses it.

## Maintenance

- Updated the Tauri stack to the latest 2.x and refreshed dependencies, resolving several security advisories.
