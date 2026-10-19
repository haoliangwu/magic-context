# Dashboard v0.8.1

A focused fix release: the embedding **Test Connection** button now works for the two setups it was wrongly rejecting, plus a couple of smaller config and discovery fixes.

## Fixes

- **Test Connection (user config) now works with `{file:...}` / `{env:...}` keys.** If your user-level `embedding.api_key` used a `{file:~/...key}` or `{env:VAR}` reference (the recommended way to keep secrets out of the config file), Test Connection refused it with a confusing message about an environment variable not being set, even for file references. It now resolves these tokens exactly like the plugin does at runtime, so the test uses your real key. Unresolved references (a missing file, or an env var the desktop app didn't inherit) are reported with accurate, kind-specific guidance, and a `{file:...}` that points into a credential directory (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`) is refused on purpose, including via `..` traversal or symlinks.

- **Test Connection now accepts `http://` and local endpoints.** A self-hosted embedding server at `http://127.0.0.1:1234/v1` (LM Studio, Ollama, llama.cpp, and similar) was rejected with "Endpoint must start with http:// or https://" even though it clearly did, because the check was HTTPS-only. Both `http://` and `https://` are now accepted, and loopback / private-LAN addresses are allowed so local servers can be tested. Cloud instance-metadata addresses stay blocked.

- **Test Connection is limited to user config.** The embedding section (provider, endpoint, API key, and the Test button) is now hidden when editing a *project* config. Project configs are shared repository files, and the plugin already ignores an embedding endpoint set there, so testing one was both pointless and a way for a shared repo to direct a key at an arbitrary endpoint. Embedding setup stays in your user config; project configs keep their own settings (like the per-project memory toggles).

- **Model discovery no longer spins up unrelated daemons.** The config page's model dropdowns run `opencode --pure models`, so opening the page no longer boots other OpenCode plugins (and the background processes some of them spawn).

## Config editor

- **New `language` field** ("Output Language") in the config editor, matching plugin v0.28.0+: set a 2-letter ISO 639-1 code (e.g. `tr`, `es`, `de`, `ja`) to keep Magic Context's generated prose in your language; leave it blank for today's behavior.
- **New `smart_drops` toggle** in Advanced config, matching plugin v0.29.0.

## Compatibility

Pair this dashboard with plugin **v0.29.0** for the `smart_drops` toggle and the matching config schema. The `language` field works with plugin **v0.28.0** and newer.
