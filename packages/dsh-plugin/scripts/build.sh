#!/usr/bin/env bash
set -e
EB="bunx --package esbuild esbuild"

# official packages are all @deepseek-ai/* — wildcard covers harness SDK, cordis stays single
EXT_HOST="--external:@deepseek-ai/dsh-* --external:@deepseek-ai/cordis"
EXT_ENTRIES="--external:@deepseek-ai/dsh-* --external:@deepseek-ai/cordis"

$EB --bundle src/index.ts --outdir=dist --platform=node --target=node20 --format=esm --splitting $EXT_HOST

# doctor CLI: prefer minimal externals, fallback if js-yaml/cordis-plugin-include missing
$EB --bundle src/doctor/cli.ts --outdir=dist --platform=node --target=node20 --format=esm --external:@deepseek-ai/cordis \
  || $EB --bundle src/doctor/cli.ts --outdir=dist --platform=node --target=node20 --format=esm --external:@deepseek-ai/cordis --external:js-yaml --external:@deepseek-ai/cordis-plugin-include

$EB --bundle src/entries/agent.ts src/entries/compaction.ts src/entries/commands.ts src/entries/tools.ts src/entries/remote.ts src/entries/preset-include.ts \
  --outdir=dist/entries --platform=node --target=node20 --format=esm --splitting $EXT_ENTRIES

# client bundle: classic-script __ModuleLoader__ factory shape (see scripts/build-client.mjs)
bun scripts/build-client.mjs

tsc --emitDeclarationOnly || echo "[dsh-magic-context] tsc emitDeclarationOnly skipped (missing @types)" >&2
