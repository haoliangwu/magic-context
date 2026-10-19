#!/usr/bin/env bash
# Check the index, not the filesystem: ignored internal docs must stay on disk.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

check_docs() {
  local path failed=0
  while IFS= read -r -d '' path; do
    case "$path" in
      docs/reports/*|docs/designs/*|docs/evidence/*|docs/specs/*|docs/investigations/*|docs/audits/*|docs/reviews/*|docs/research/*|docs/plans/*|docs/private/*|docs/protected-tokens/*)
        printf 'FAIL: docs public-only guard: %s\n' "$path" >&2
        failed=1
        ;;
      docs/*/*) ;;
      # Every loose public document is reviewed explicitly. An allowlist also
      # catches reports whose names do not contain words like "audit" or "probe".
      docs/logo.png|docs/logo-cropped.png|docs/dist-chunk-lifecycle.md|docs/migration-version-lanes.md) ;;
      docs/*)
        printf 'FAIL: docs public-only guard: unreviewed loose file %s\n' "$path" >&2
        failed=1
        ;;
    esac
  done < <(git ls-files -z -- docs)
  [ "$failed" -eq 0 ] || return 1
  printf 'PASS: docs public-only guard\n'
}

check_docs
