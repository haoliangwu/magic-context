#!/bin/sh
# CI sentinel: exit at the first new failed/cancelled job, even mid-run.
# Failure notification uses stdout headed by "CI FAILURE DETECTED:" and
# exit 1, for callers monitoring process completion. Failed/cancelled runs get a
# separate report; successful run completion is silent, as before.
#
# Usage: scripts/ci-sentinel.sh [max_hours] | --once | --install | --uninstall
# Exit 0 = clean window elapsed (default 8h), or --once found nothing new.
# --install (macOS only) installs com.cortexkit.mc-ci-sentinel in the user's
# LaunchAgents. launchd re-arms after exits and restarts at login/reboot.
# --uninstall unloads/removes the agent but retains state and logs.
#
# Owner-only state and launchd logs live in
# ~/.local/share/cortexkit/magic-context/ci-sentinel/ (directory 0700,
# files 0600). reports.log appends the same stdout blocks as manual use:
# CI FAILURE DETECTED:
# <run-id> <workflow-name> <branch> <created-at>    (legacy run descriptor)
#   run: <run-id> attempt: <n> status: <status> conclusion: <conclusion>
#   head: <sha> branch: <branch>
#   job: <name> (<failure|cancelled>, id: <job-id>)   (job reports only)
#   log: ...                                    (best effort, bounded)
# errors.log holds query/backoff diagnostics, never failure reports.
# This script sends no agent notification itself. Existing callers monitor
# process completion and read stdout; launchd needs a separate consumer
# following reports.log for notifications after the original caller is gone.
#
# Discovery covers the latest 15 runs; observed active runs remain watched
# even if newer runs displace them. gh handles job-list pagination. A job's
# log may be unavailable until its whole run finishes; a report does not
# require logs or wait for run completion. Queries time out after 30s; logs
# after 10s, with at most 20 lines / 8 KiB included in the report.
# CI_SENTINEL_STATE_DIR, CI_SENTINEL_POLL_SECONDS, and
# CI_SENTINEL_MAX_BACKOFF_SECONDS can override the defaults for testing.
set -u
umask 077
LABEL=com.cortexkit.mc-ci-sentinel
STATE_DIR=${CI_SENTINEL_STATE_DIR:-"$HOME/.local/share/cortexkit/magic-context/ci-sentinel"}
POLL_SECONDS=${CI_SENTINEL_POLL_SECONDS:-45}
MAX_BACKOFF=${CI_SENTINEL_MAX_BACKOFF_SECONDS:-900}
MODE=${1:-8}

die() { printf '%s\n' "$*" >&2; exit 2; }
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
xml_escape() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
init_state() {
  mkdir -p "$STATE_DIR" || die "Cannot create sentinel state directory"
  chmod 700 "$STATE_DIR" || die "Cannot secure sentinel state directory"
  for state_file in seen active reports.log errors.log; do
    touch "$STATE_DIR/$state_file" || die "Cannot create sentinel state file"
    chmod 600 "$STATE_DIR/$state_file" || die "Cannot secure sentinel state file"
  done
}

case "$MODE" in
  --install|--uninstall)
    [ "$(uname -s)" = Darwin ] || die "launchd installation requires macOS"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    DOMAIN="gui/$(id -u)"
    if [ "$MODE" = --uninstall ]; then
      launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || :
      rm -f "$PLIST" || die "Cannot remove $PLIST"
      printf 'Uninstalled %s; state and logs retained at %s\n' "$LABEL" "$STATE_DIR"
      exit 0
    fi
    command -v gh >/dev/null 2>&1 || die "Install gh and authenticate before installing the sentinel"
    SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 2
    SCRIPT="$SCRIPT_DIR/$(basename -- "$0")"
    REPO_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P) || exit 2
    init_state
    mkdir -p "$(dirname -- "$PLIST")" || exit 2
    PLIST_TMP=$(mktemp "$PLIST.XXXXXX") || exit 2
    cat > "$PLIST_TMP" <<EOF || exit 2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$(xml_escape "$SCRIPT")</string></array>
<key>WorkingDirectory</key><string>$(xml_escape "$REPO_DIR")</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$(xml_escape "$PATH")</string>
<key>CI_SENTINEL_STATE_DIR</key><string>$(xml_escape "$STATE_DIR")</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>45</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>$(xml_escape "$STATE_DIR/reports.log")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$STATE_DIR/errors.log")</string>
</dict></plist>
EOF
    chmod 600 "$PLIST_TMP" && mv -f "$PLIST_TMP" "$PLIST" || exit 2
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || :
    launchctl enable "$DOMAIN/$LABEL" || exit 2
    launchctl bootstrap "$DOMAIN" "$PLIST" || exit 2
    printf 'Installed %s; reports append to %s/reports.log\n' "$LABEL" "$STATE_DIR"
    exit 0
    ;;
  --once) MAX_HOURS=8 ;;
  *) is_uint "$MODE" || die "Usage: $0 [max_hours] | --once | --install | --uninstall"
     MAX_HOURS=$MODE ;;
esac
is_uint "$POLL_SECONDS" && [ "$POLL_SECONDS" -gt 0 ] || die "Poll interval must be positive"
is_uint "$MAX_BACKOFF" && [ "$MAX_BACKOFF" -ge "$POLL_SECONDS" ] || die "Backoff cap must be at least the poll interval"
init_state
SEEN_FILE="$STATE_DIR/seen"
WORK=$(mktemp -d "$STATE_DIR/poll.XXXXXX") || exit 2
GH_PID=
TIMER_PID=
# Invoked by the EXIT trap, including signal-driven exits.
# shellcheck disable=SC2329
cleanup() {
  [ -z "$GH_PID" ] || kill "$GH_PID" 2>/dev/null || :
  [ -z "$TIMER_PID" ] || kill "$TIMER_PID" 2>/dev/null || :
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
DEADLINE=$(( $(date +%s) + MAX_HOURS * 3600 ))
BACKOFF=$POLL_SECONDS
ERROR_STREAK=0
TAB=$(printf '\t')
RUN_FIELDS=databaseId,workflowName,headBranch,headSha,status,conclusion,createdAt,attempt
RUN_ROW='def nonempty: if . == null or . == "" then "-" else . end; [.databaseId, (.attempt // 1), (.workflowName | nonempty), (.headBranch | nonempty), (.headSha | nonempty), .status, (.conclusion | nonempty), .createdAt] | @tsv'
# GitHub's ISO creation times sort lexically when comparing sibling runs.
is_superseded() {
  SUPERSEDED=$(LC_ALL=C awk -F "$TAB" -v workflow="$WORKFLOW" -v branch="$BRANCH" -v created="$CREATED" '$3 == workflow && $4 == branch && $8 > created { found = 1; exit } END { print found ? 1 : 0 }' "$WORK/runs")
}

# Keep API failures distinct from empty results, with a portable wall deadline.
gh_bounded() {
  GH_SECONDS=$1
  GH_OUTPUT=$2
  shift 2
  gh "$@" > "$GH_OUTPUT" 2> "$WORK/gh.err" &
  GH_PID=$!
  (
    SLEEP_PID=
    trap '[ -z "$SLEEP_PID" ] || kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM
    sleep "$GH_SECONDS" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" && kill -KILL "$GH_PID" 2>/dev/null
  ) >/dev/null 2>&1 &
  TIMER_PID=$!
  GH_RC=0
  wait "$GH_PID" 2>/dev/null || GH_RC=$?
  kill "$TIMER_PID" 2>/dev/null || :
  wait "$TIMER_PID" 2>/dev/null || :
  GH_PID=
  TIMER_PID=
  return "$GH_RC"
}
seen() { grep -qxF "$1" "$SEEN_FILE"; }
remember() { printf '%s\n' "$1" >> "$SEEN_FILE" || die "Cannot persist sentinel dedup state"; }
describe_run() {
  printf '%s %s %s %s\n' "$RUN_ID" "$WORKFLOW" "$BRANCH" "$CREATED"
  printf '  run: %s attempt: %s status: %s conclusion: %s\n' "$RUN_ID" "$ATTEMPT" "$STATUS" "$CONCLUSION"
  printf '  head: %s branch: %s\n' "$SHA" "$BRANCH"
}
job_log() {
  # gh may refuse logs from a still-running workflow. Logs are optional and
  # deadline-bounded; their absence must not suppress the job report.
  gh_bounded 10 "$WORK/log" run view --job "$JOB_ID" --log-failed || return 0
  awk '
    /FAIL|fail|Error:|error:|Assertion|assertion|panic|test result:/ {
      line = substr($0, 1, 400)
      if (bytes + length(line) + 8 > 8192 || count == 20) exit
      print "  log: " line
      bytes += length(line) + 8; count++
    }
  ' "$WORK/log"
}
poll() {
  POLL_FAILED=0
  : > "$WORK/reports"
  : > "$WORK/active"
  gh_bounded 30 "$WORK/runs" run list --limit 15 --json "$RUN_FIELDS" -q ".[] | $RUN_ROW" || return 2
  # Preserve watched IDs outside the discovery window. Refresh metadata so
  # reruns use a separate attempt key rather than hiding a new completion.
  while IFS= read -r ACTIVE_ID; do
    [ -n "$ACTIVE_ID" ] || continue
    if ! cut -f1 "$WORK/runs" | grep -qxF "$ACTIVE_ID"; then
      if gh_bounded 30 "$WORK/run" run view "$ACTIVE_ID" --json "$RUN_FIELDS" -q "$RUN_ROW"; then
        cat "$WORK/run" >> "$WORK/runs"
      else
        printf '%s\n' "$ACTIVE_ID" >> "$WORK/active"
        POLL_FAILED=1
      fi
    fi
  done < "$STATE_DIR/active"
  while IFS="$TAB" read -r RUN_ID ATTEMPT WORKFLOW BRANCH SHA STATUS CONCLUSION CREATED; do
    [ -n "$RUN_ID" ] || continue
    is_superseded
    if [ "$STATUS" != completed ]; then
      printf '%s\n' "$RUN_ID" >> "$WORK/active"
    elif seen "checked:$RUN_ID:$ATTEMPT"; then
      continue
    fi
    if gh_bounded 30 "$WORK/jobs" run view "$RUN_ID" --json jobs -q '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled") | [.databaseId, .conclusion, .name] | @tsv'; then
      while IFS="$TAB" read -r JOB_ID JOB_CONCLUSION JOB_NAME; do
        [ -n "$JOB_ID" ] || continue
        # CI (required) aggregates shards, so cancellations in an older run can make it fail.
        if [ "$SUPERSEDED" -eq 1 ] && { [ "$JOB_CONCLUSION" = cancelled ] || { [ "$JOB_CONCLUSION" = failure ] && [ "$JOB_NAME" = 'CI (required)' ]; }; }; then
          continue
        fi
        seen "job:$JOB_ID" && continue
        remember "job:$JOB_ID"
        {
          describe_run
          printf '  job: %s (%s, id: %s)\n' "$JOB_NAME" "$JOB_CONCLUSION" "$JOB_ID"
          job_log
        } >> "$WORK/reports"
      done < "$WORK/jobs"
      [ "$STATUS" != completed ] || remember "checked:$RUN_ID:$ATTEMPT"
    else
      POLL_FAILED=1
      [ "$STATUS" != completed ] || printf '%s\n' "$RUN_ID" >> "$WORK/active"
    fi
    if [ "$STATUS" = completed ] && { [ "$CONCLUSION" = failure ] || [ "$CONCLUSION" = cancelled ]; } && ! seen "run:$RUN_ID:$ATTEMPT"; then
      if [ "$CONCLUSION" != cancelled ] || [ "$SUPERSEDED" -eq 0 ]; then
        remember "run:$RUN_ID:$ATTEMPT"
        describe_run >> "$WORK/reports"
      fi
    fi
  done < "$WORK/runs"
  mv -f "$WORK/active" "$STATE_DIR/active" || die "Cannot persist watched runs"
  if [ -s "$WORK/reports" ]; then
    printf 'CI FAILURE DETECTED:\n'
    cat "$WORK/reports"
    return 1
  fi
  [ "$POLL_FAILED" -eq 0 ] || return 2
  return 0
}

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  RESULT=0
  poll || RESULT=$?
  [ "$RESULT" -ne 1 ] || exit 1
  if [ "$RESULT" -eq 2 ]; then
    if [ "$ERROR_STREAK" -eq 0 ]; then
      printf 'CI sentinel: gh query failed; retrying with backoff (up to %ss).\n' "$MAX_BACKOFF" >&2
    fi
    ERROR_STREAK=1
    BACKOFF=$(( BACKOFF * 2 ))
    [ "$BACKOFF" -le "$MAX_BACKOFF" ] || BACKOFF=$MAX_BACKOFF
  else
    ERROR_STREAK=0
    BACKOFF=$POLL_SECONDS
  fi
  if [ "$MODE" = --once ]; then exit "$RESULT"; fi
  sleep "$BACKOFF"
done
printf 'clean window elapsed (%sh) — re-arm the sentinel\n' "$MAX_HOURS"
exit 0
