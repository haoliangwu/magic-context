#!/usr/bin/env bash
set -euo pipefail

# Reproduce tests/docker/test-omp-e2e.sh with /test and /tmp under a throwaway
# root, plus event tracing and lsof snapshots of the real host. A private home
# also isolates OMP's plugin install, doctor repairs and SQLite.
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
mkdir -p "${TMPDIR:-/tmp}/magic-context/issue-673"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/issue-673/print.XXXXXX")
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_RUNTIME_DIR="$ROOT/runtime"
export TMPDIR="$ROOT/tmp"
export MAGIC_CONTEXT_STORAGE_DIR="$XDG_DATA_HOME/cortexkit/magic-context"
export npm_config_prefix="$ROOT/npm"
mkdir -p "$HOME" "$TMPDIR" "$ROOT/test" "$ROOT/bin"
mkdir -m 700 "$XDG_RUNTIME_DIR"
export PATH="$ROOT/bin:$ROOT/npm/bin:$PATH"
echo "Isolated smoke root: $ROOT"
bun --version
node --version
npm --version

bun run --cwd packages/pi-plugin build
bun run --cwd packages/pi-plugin build:e2e-argv
bun run --cwd packages/cli build
npm install --prefix "$ROOT/npm" -g --no-audit --no-fund @oh-my-pi/pi-coding-agent@18.10.4
omp --version

cp -R packages/pi-plugin/dist "$ROOT/test/mc-pi-dist"
mkdir -p "$ROOT/test/mc-pi" "$ROOT/test/e2e" "$ROOT/test/mc-cli"
mv "$ROOT/test/mc-pi-dist" "$ROOT/test/mc-pi/dist"
cp packages/pi-plugin/package.json packages/pi-plugin/README.md "$ROOT/test/mc-pi/"
cp -R tests/docker/.generated/. "$ROOT/test/e2e/"
cp packages/pi-plugin/package.json "$ROOT/test/e2e/"
cp -R packages/cli/dist "$ROOT/test/mc-cli/"
cp packages/cli/package.json "$ROOT/test/mc-cli/"
for package in mc-pi mc-cli; do
  (cd "$ROOT/test/$package" && npm install --omit=dev --no-audit --no-fund --workspaces=false --no-package-lock --legacy-peer-deps)
done
(cd "$ROOT/test" && npm init -y >/dev/null && npm install --no-audit --no-fund @copilotkit/aimock)
chmod +x "$ROOT/test/mc-cli/dist/index.js"
ln -s "$ROOT/test/mc-cli/dist/index.js" "$ROOT/bin/magic-context"
omp plugin install "$ROOT/test/mc-pi"
omp plugin list --json

git config --global user.email "test@cortexkit.local"
git config --global user.name "Magic Context CI"
mkdir -p "$ROOT/test/project"
(cd "$ROOT/test/project" && git init -q && printf '%s\n' '{"name":"test","version":"1.0.0"}' >package.json && git add -A && git commit -q -m init)
cp tests/docker/fixtures/aimock-pi.cjs "$ROOT/test/aimock-server.cjs"
export ROOT REPO
export REAL_BUN="$(command -v bun)"
python3 - <<'PY'
import os
import re
from pathlib import Path
root = os.environ['ROOT']
source = Path(os.environ['REPO'], 'tests/docker/test-omp-e2e.sh').read_text()
Path(root, 'test/test-omp-e2e.sh').write_text(re.sub(r'/test/|/tmp/', lambda m: root + m[0], source))
PY

mkdir -p "$HOME/.omp/agent/extensions"
cat >"$HOME/.omp/agent/extensions/dispatch-trace.ts" <<'TS'
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
export default function (pi: any) {
  for (const type of ["agent_start", "context", "before_provider_request", "agent_end"]) {
    pi.on(type, (event: any) => {
      if (type === "before_provider_request") {
        appendFileSync(`${process.env.TMPDIR}/host-${process.pid}.lsof`, execFileSync("lsof", ["-p", String(process.pid)]));
      }
      const messages = event.payload?.messages ?? event.messages;
      appendFileSync(`${process.env.TMPDIR}/dispatch-trace.jsonl`, JSON.stringify({
        type, at: Date.now(),
        messages: messages?.map((m: any) => ({ role: m.role, timestamp: m.timestamp,
          content: typeof m.content === "string" ? m.content.slice(0, 80) : m.content?.map((c: any) => ({ type: c.type, text: c.text?.slice(0, 80) })) })),
      }) + "\n");
    });
  }
}
TS

# Inspect the actual Bun host, not the timeout shell surrounding the smoke turn.
cat >"$ROOT/bin/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " != *" --print "* ]]; then exec "$REAL_BUN" "$@"; fi
"$REAL_BUN" "$@" &
host=$!
sleep 0.5
lsof -p "$host" >>"$ROOT/tmp/host-$host.lsof" || true
sleep 0.5
lsof -p "$host" >>"$ROOT/tmp/host-$host.lsof" || true
wait "$host"
SH
chmod +x "$ROOT/bin/bun"
set +e
(cd "$ROOT/test/project" && bash "$ROOT/test/test-omp-e2e.sh") >"$ROOT/tmp/smoke.log" 2>&1
result=$?
set -e
python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ['ROOT'])
for line in (root / 'tmp/smoke.log').read_text().splitlines():
    if line.startswith(('---', 'PASS', 'FAIL', 'OMP version:', 'OMP exit:', 'OMP subagent exit:')):
        print(line)
log = root / 'tmp/omp/magic-context/magic-context.log'
print('MC log:', log)
if log.exists():
    for line in log.read_text().splitlines():
        if any(s in line for s in ('CONTEXT REFUSED', 'transform completed', 'publication', 'agent_end', 'OMP context counts')):
            print(line)
for name in ('aimock.log', 'smoke.log', 'omp.log', 'omp-subagent.log', 'dispatch-trace.jsonl'):
    path = root / 'tmp' / name
    if not path.exists():
        continue
    print('Diagnostics:', path)
    for line in path.read_text().splitlines():
        if line.startswith('{'):
            import json
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get('type') == 'message_end':
                message = event.get('message', {})
                print('message_end:', message.get('role'), message.get('stopReason'), message.get('errorMessage'), str(message.get('content'))[:200])
            elif name == 'dispatch-trace.jsonl':
                print(line)
        elif any(s in line for s in ('Error', 'error', 'failed', 'refused', 'Interrupted')):
            print(line[:1000])
snapshots = sorted((root / 'tmp').glob('host-*.lsof'))
if len(snapshots) < 2:
    raise RuntimeError('lsof did not observe both the main and child host')
for snapshot in snapshots:
    print('Host open-file evidence:', snapshot)
    rows = [line for line in snapshot.read_text().splitlines() if any(s in line for s in ('.db', '/.omp/', '/.pi/', '/.config/', '/magic-context/'))]
    if not rows:
        raise RuntimeError('lsof did not observe isolated host files')
    print('\n'.join(rows))
    if any(str(root) not in row for row in rows):
        raise RuntimeError('host opened a state path outside the throwaway root')
PY
exit "$result"
