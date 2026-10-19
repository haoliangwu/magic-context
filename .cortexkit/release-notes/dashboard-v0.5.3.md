# Dashboard v0.5.3

A small patch release: clear stuck dream-queue entries, reference notes by id, and fixes to the per-model config rows and several project-scoped views.

## What's New

- **Remove stale entries from the dream queue.** Pending dream-queue cards now have a Remove button, so a run you started for a project that no longer has an active runner (e.g. queued from the dashboard, then the project went idle) can be cleared instead of sitting there forever.

- **Notes show their id.** Session notes and smart notes now display their `#id`, so you can reference a specific note unambiguously when discussing or acting on it.

## What's Fixed

- **Per-model config sliders are draggable again.** In the Config editor, per-model override sliders (e.g. Execute Threshold %) only moved one tick and then stopped — the row's DOM was being recreated on every input, which dropped the slider mid-drag. They now drag smoothly, and the slider fills the full row width instead of stopping short with a large empty gap before the value.

- **Per-model override rows line up.** Longer model names no longer push a row's input, slider, value, and remove button out of alignment, and the Default row now lines up with the override rows below it.

- **Dream runs appear for all projects.** The Dreamer panel resolved project filters by raw path, so projects keyed by a normalized identity (the common case) could show no dream runs even when runs existed. It now resolves the same identities the rest of the dashboard uses.

- **Correct session project identity.** Session detail now resolves a session's Magic Context project identity from its worktree, matching the identity used by the project-scoped memory, notes, and key-file views — instead of OpenCode's internal project hash, which lives in a different space.

- **Pinning a memory no longer over-invalidates the cache.** Bulk memory status changes only refresh a running session's cache for rows whose status actually changed; a no-op update (a memory already in the target status) no longer forces an unnecessary re-render.
