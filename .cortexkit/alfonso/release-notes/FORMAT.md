# Release notes format

Every release's notes (`.cortexkit/alfonso/release-notes/vX.Y.Z.md`, published as the GitHub release body) follow this format, shared across CortexKit projects. The reference example is AFT's v0.58.0 release: https://github.com/cortexkit/aft/releases/tag/v0.58.0

```
# vX.Y.Z

<2–4 plain sentences: what this release is about for a user.>

## Upgrading
- <an action a user must take, or a default that changed; exact commands and keys>

## New
- <one line per feature>

## Changed
- <one line per behaviour change>

## Fixed
- <one line per fix> (#N, thanks @user)

## Security
- <one line per item>
```

Rules:
- **One line per item, at most about 25 words:** what changed for the user, not how it works inside. No mechanism explanations, and no internal vocabulary (component, train, slice or task names).
- **Group related fixes into one line** where a user would think of them as one thing, with every issue number: "Linked worktrees now search the right files (#337, #338)".
- **Link to the docs for details** instead of explaining them in the notes. If the detail a user needs isn't in the docs, add it there.
- **Omit empty sections.** Upgrading comes first because it's what a user must act on.
- **Credit every reporter and contributor** on the items they reported or fixed.
- **Build the notes from an inventory of every commit since the previous release,** grouped into user-visible changes. Check each change against the released code, not commit subjects: provenance merges list branches whose code never shipped. Leave out internal work (tests, CI, benchmarks, refactors) unless users feel it.
- **Each paragraph is a single source line.** GitHub renders release bodies with hard line breaks. `node scripts/check-release-notes.mjs <file>` must pass.
- As a guide, aim for under about 1,200 words even for a large release.
