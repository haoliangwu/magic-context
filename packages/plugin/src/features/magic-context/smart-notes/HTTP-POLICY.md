# Smart-note HTTP checks

Network responses are streamed, stopped before storing the chunk that crosses the
limit, and bounded to **1 MiB per httpGet**, including redirect bodies and any
container-readability probe. DNS validation, pinned connections, address fanout,
redirect bounds, cancellation and the single wall-clock deadline still apply.
Oversized responses report the URL, observed minimum byte count and limit as a
persistent failure, not as evidence of absence or of a met condition.

The original 64 KiB limit was introduced with compiled checks in commit
34f5ef74c34d7da013f497ff3eb6d4c2a28563a3. Blame and `git log -S` locate it in
the streaming transport alongside timeout and sandbox resource bounds; the commit
contains no explanation of the specific numeric choice. It bounds untrusted
network/memory input, not model input: response bodies go to QuickJS, never to the
compiler or confirmation model. The compiler still limits repair error feedback
to 2 KiB, generated output to 128 Ki characters and compiled code to 64 KiB.
The local readFile limit remains 64 KiB and the sandbox heap remains 8 MiB.

## Absence versus inaccessible data

A watched resource returning 404 or 410 is absent. Normal guest verdicts are
trusted: absence can mean met for a deletion or withdrawal condition. Old compiled
checks sometimes throw on every non-200 status. The shared fetch helper classifies
HTTP access failures, and the sandbox preserves the absence observation outside
guest code: when a check throws after observing absence without a host network
failure, it becomes not met instead of an exception. Host network failures remain
failures even when guest code catches them and returns `met: true`.

GitHub conceals private repositories with 404. For GitHub API, raw-content and web
URLs, an absent resource first requires a readable `/repos/OWNER/REPO` response.
For npm URLs, it requires readable package metadata (including scoped names).
These probes use the same SSRF policy and byte/deadline budgets as the resource.
A 404/410 container response is indistinguishable from a nonexistent container;
both are reported as **not publicly readable**, not claimed to be private or
permanently nonexistent. This is deliberate: missing repositories/packages require
owner repair or a different data source, whereas missing releases/files/versions
inside readable containers are normal waiting states. Inaccessible containers and
non-rate-limited 401/403/451 responses park the note rather than retrying forever.

Generic document origins have no universal container-metadata API, so their
404/410 responses indicate absence without a probe. This cannot detect arbitrary
sites disguising authorization failures as 404. Explicit 401/403 and legal-access
451 responses are persistent access failures. HTTP 401/403/429 with exhausted
rate-limit headers or Retry-After is transient, not an authorization diagnosis.
The host preserves the maximum reset epoch / Retry-After (seconds or HTTP date)
through sandbox and compiler failures into scheduled-check, compilation and
liveness backoff. Retries wait until at least that deadline and the ordinary
backoff, with a five-minute minimum if hints are missing/malformed. Rate limits
never trigger owner notices or reauthor a healthy check. HTTP 408/429, 5xx and transport
failures/timeouts retry later. None constitutes evidence that a condition is met.

Persistent failures in compilation, scheduled checks and liveness checks use the
same stored, deduplicated owner notice, keyed by note and condition. Dismissal of
the notice does not cause another alert for an unchanged condition. The smart note
itself stays pending and visible in `ctx_note read`. Uncheckable sources store
`check_status = 'parked'` and the reason in `ready_reason`; compilation, scheduled
checks, liveness checks and fallback evaluation all skip them. Updating the note's
`surface_condition` to a different condition clears the parked state and reason
and schedules compilation again. Content-only edits do not un-park a note.
Other persistent failures, such as oversized responses after bounded-endpoint
repair, retain the existing week-long recompilation backoff.

## GitHub authentication

The smart-note transport has no configured GitHub-token support. It sends only
Host, User-Agent and Accept; neither GITHUB_TOKEN nor GH_TOKEN nor another
component's configured token is read or sent. Checks therefore share the public
unauthenticated quota. Adding authenticated requests needs a separate explicit
credential policy so redirect targets and unrelated note URLs cannot receive a
token. Header hints prevent quota failures from becoming permanent owner alerts,
but do not increase that quota or coalesce requests from different notes.

GitHub `/search/code` requires authentication even for public repositories. The
compiler refuses literal code-search endpoints before its dry run, and the HTTP
guard refuses them at runtime (including redirects and older compiled checks).
The compiler is instructed to use public contents or bounded commits endpoints
only if they answer the same question, not to silently weaken the condition.
