# Dashboard v0.9.2

Performance release: the Projects page no longer runs git at all.

## Fixed

### Projects page could take minutes to load
The dashboard used to determine each session's project by running `git rev-list` across every distinct session directory on every page load. On machines with many worktrees, deleted directories, or directories on slow network paths, this made the Projects page take minutes to appear (reported at over two minutes).

The dashboard now reads the session-to-project index that the Magic Context plugin records (plugin v0.30.7 adds a one-time backfill for existing sessions), turning the page into a couple of indexed database reads. Git is never spawned by the dashboard anymore, and a regression test keeps it that way.

One behavior note: sessions that predate the index appear in session lists but are not grouped into project cards until the plugin (v0.30.7+) has started once and completed its background backfill. Update both the plugin and the dashboard for the full effect.
