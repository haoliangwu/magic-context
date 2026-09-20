#!/usr/bin/env bash
# Install the OpenCode CLI inside an e2e image, loudly and without the GitHub API.
#
# The official one-liner (`curl -fsSL https://opencode.ai/install | bash`) fails in
# two silent or recurring ways from CI:
#   - a transient reset on the installer fetch leaves bash reading an empty script,
#     the pipeline exits 0, the Docker layer is marked DONE, and every test in the
#     image later fails with `opencode: not found` (release gate, 2026-09-18);
#   - with no version pinned the installer resolves "latest" through
#     api.github.com, which is rate-limited per source IP and routinely exhausted
#     on shared runner egress ("Failed to fetch version information", release
#     gates on 2026-09-13, 09-15 and again locally on 09-18).
# So: download the installer to a file (its fetch has its own exit status),
# resolve the latest tag from the releases redirect on github.com (no API), run the
# installer with that version pinned (direct download URL, HEAD on github.com), retry
# each network step with backoff, and assert the binary runs before the layer ends.
# An explicit OPENCODE_VERSION (e.g. 1.18.30) skips the resolution step.
set -euo pipefail

retry() {
    # retry <label> <cmd...>: five attempts with linear backoff, loud on give-up.
    local label="$1"
    shift
    local attempt=0
    until "$@"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 5 ]; then
            echo "install-opencode: $label failed after $attempt attempts" >&2
            return 1
        fi
        echo "install-opencode: $label failed (attempt $attempt); retrying" >&2
        sleep $((attempt * 5))
    done
}

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT

fetch_installer() {
    curl -fsSL --connect-timeout 15 --max-time 120 https://opencode.ai/install -o "$installer" \
        && [ -s "$installer" ]
}
retry "installer fetch" fetch_installer

version="${OPENCODE_VERSION:-}"
if [ -z "$version" ]; then
    resolve_version() {
        # github.com answers /releases/latest with a redirect to /releases/tag/vX.Y.Z;
        # reading the Location header needs no API token and no rate-limit budget.
        local location
        location="$(curl -fsSI --connect-timeout 15 --max-time 60 \
            https://github.com/anomalyco/opencode/releases/latest \
            | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1)"
        version="${location##*/tag/v}"
        [ -n "$version" ] && [ "$version" != "$location" ]
    }
    retry "latest version resolution" resolve_version
fi
echo "install-opencode: installing opencode v${version}"

run_installer() { bash "$installer" --version "$version"; }
retry "installer run" run_installer

export PATH="/root/.opencode/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
    echo "install-opencode: installer completed but no opencode binary on PATH" >&2
    exit 1
fi
opencode --version
