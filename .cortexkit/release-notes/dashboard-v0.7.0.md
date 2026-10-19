## Magic Context Dashboard v0.7.0

### Cache Diagnostics, rebuilt

The Cache page now tracks each session in its own bounded window instead of a
shared global event pool, so the Recent Sessions cards show **per-session**
hit-ratio, event count, and bust count that no longer drift with how busy other
sessions are.

- **Per-session windows.** Pick how many recent events to keep per session
  (200 / 400 / 600 / 800 / 1000); cards and the timeline both reflect exactly
  that window.
- **Live, reliable refresh.** A 1-second loop re-lists sessions and fetches only
  *new* events per session, so the Recent Sessions strip stays current without
  the manual pause/unpause it sometimes needed before.
- **One-line strip.** Recent Sessions render as a single row of equal-width
  cards; how many show adapts to the window width.

### Cache timeline

- **Context-scaled bars.** Bar height is the prompt size relative to the model's
  context window, with an inner cached segment — so you can see the prompt grow
  and drop across a session at a glance.
- **Accurate severity.** Cache health is judged by comparing each step's cached
  read against what the previous step predicted, instead of a raw ratio that
  false-warned on large file reads. Providers that don't report cache data show
  as "unknown" rather than a misleading bust.
- **Magic-Context-attributed drops.** Drop markers correlate to the actual
  scheduler decision recorded by the plugin (execute / materialize / emergency),
  shown in a tooltip. The blue drop line is now clickable and jumps to the step.
- **Importance heat-map.** The compartment strip in the session view colors each
  segment by its importance band (critical / high / medium / low) instead of a
  meaningless rainbow.

### Memories & projects

- **Edit a memory's category** directly from the dashboard (#158).
- **Non-git projects** now appear in the project picker and filter their memories
  correctly (#160).
- **Real project names.** Sessions that ran in a git repo with no remote/commit
  no longer display as "/"; they show their actual directory.
- **Windows model dropdown** is populated for version-manager installs
  (mise / nvm / fnm / volta / asdf) and via a PATH fallback (#149).
