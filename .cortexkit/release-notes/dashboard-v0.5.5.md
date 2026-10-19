# Dashboard v0.5.5

## New platforms

- **Linux ARM64** builds (AppImage, deb, rpm) — for ARM laptops, Asahi Linux, and Apple Silicon VMs. Previously only x64 was available, which fails under x86 emulation.
- **Windows ARM64** builds (NSIS installer) — native builds for Windows on ARM devices.

## Fixes

- Config editor: the **Inject docs** toggle now correctly shows as enabled when the key is absent from your config, matching the actual default behavior (#134). Display-only — docs injection itself was always working.

## Dependencies

- Updated `tar` and `openssl` transitive dependencies.
