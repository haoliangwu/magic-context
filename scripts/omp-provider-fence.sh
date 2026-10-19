#!/usr/bin/env bash
set -euo pipefail
: "${MC683_ROOT:?Set MC683_ROOT under TMPDIR/magic-context/issue-673}"
: "${MC683_HOST:?Set MC683_HOST to an exact OMP 18.10.4 or 18.11.0 npm installation}"
case "$MC683_ROOT" in */magic-context/issue-673/*) ;; *) exit 2 ;; esac
root="$(mktemp -d "$MC683_ROOT/provider.XXXXXX")"
root="$(cd "$root" && pwd -P)"
printf 'host evidence: %s\n' "$root"
code=0
env -i PATH="$PATH" HOME="$root" CFFIXED_USER_HOME="$root" TMPDIR="$root" \
  XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
  XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime" \
  PI_CODING_AGENT_DIR="$root/.omp/agent" MAGIC_CONTEXT_STORAGE_DIR="$root/data/cortexkit/magic-context" \
  MC683_RUN_ROOT="$root" MC683_HOST="$MC683_HOST" \
  bun "$(dirname "$0")/omp-provider-fence.ts" "$@" > "$root/output.txt" 2>&1 || code=$?
printf '%s\n' "$(<"$root/output.txt")"
exit "$code"
