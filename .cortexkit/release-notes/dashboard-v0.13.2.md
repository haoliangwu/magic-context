## Dashboard v0.13.2

Two fixes for issues reported on 0.13.1 (thanks johnatas-henrique):

- The Logs tab now resolves the Magic Context log at the correct platform path (Windows `%TEMP%` included) and reads both harness-scoped locations, honoring `MAGIC_CONTEXT_LOG_PATH`. (#351)
- Updating a Dreamer task from a workspace-member project no longer fails with "Config path is outside the project directory" — writes derive from the canonical project root, with containment and symlink protections unchanged. (#352)
