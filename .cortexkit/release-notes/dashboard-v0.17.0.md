## Dashboard v0.17.0

Works with Magic Context 0.43.0, including OpenCode 2.

### OpenCode 2 sessions
The dashboard reads OpenCode 2's store as well as OpenCode 1's, including a store OpenCode 2 has converted in place. A store counts as OpenCode 2 only when the OpenCode 1 message tables are absent, so an OpenCode 1 store that merely contains the newer tables is no longer misread. A session converted from OpenCode 1 keeps its id, and the dashboard now matches it by that id across both labels, so its timeline uses the real context limit instead of scaling to its own largest prompt.

### Model pickers survive OpenCode 2's cold start
On a cold start `opencode models` can print nothing for over 30 seconds while OpenCode 2 installs its plugins. Model discovery now waits up to 45 seconds, shows a readable error (such as "timed out after 45s") instead of an empty picker, retries once on its own and offers a manual retry, and never replaces a catalog that already loaded with an empty one.

### Live config keys are marked
Settings that take effect without a restart (historian and dreamer models, fallbacks and variants, dreamer schedules and several others) carry a **Live** badge in the config editor. The list comes from the same schema mark that drives the docs, so the two cannot disagree.

### Cache Diagnostics shows Broca runs
Runs recorded in Broca's run index appear as their own harness, with the same cache figures and timeline as other sessions. The index is opened read-only. Each Broca run is one point on the timeline, because Broca keeps usage per run rather than per step.

### Compartments count includes the newest history
The context breakdown now counts compartments served in `<session-history-since>` as well as `<session-history>`, so a session whose main history block was built before its first compartment no longer shows a near-zero Compartments figure.

### Log viewer reads the current fleet log format
The log viewer parses the fleet's current log format (schema 2), decodes the control-character escapes it writes inside field values, and still reads the older formats.

### Smaller changes
- Historian runs that timed out or returned empty output are labelled "Timed out" and "Empty output" in the session viewer.
- The `/ctx-session-upgrade` reference is gone from the session viewer, matching its removal from the plugin.
