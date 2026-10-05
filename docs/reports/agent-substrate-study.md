# Agent Substrate and `env`: what they do, and what CortexKit can learn

Date: 2026-09-28.

Scope: two read-only clones, compared with the CortexKit module design r6 (`.cortexkit/alfonso/plans/ck-extensibility-design-r6.md`) and its rulings (`.cortexkit/alfonso/plans/ck-extensibility-r6-rulings.md`).

| Repository | Clone | Commit read |
|---|---|---|
| github.com/agent-substrate/substrate | `~/Work/OSS/agent-substrate-substrate` | `ed6d2a1` (2026-09-26) |
| github.com/agent-substrate/env | `~/Work/OSS/agent-substrate-env` | `ab40c7b` (2026-09-11) |

Citation form: `substrate:<path>:<lines>` and `env:<path>:<lines>` point into the clones at those commits. `r6 §N` points into our design. Nothing was built or run in the clones. Where running something would settle a question, the report says so.

A caution before the details. Substrate's own architecture document opens with "Much of this architecture is aspirational, and is not yet implemented!" (`substrate:docs/architecture.md:3`). Several of its documents describe checks that the code at this commit does not perform. This report states what the code does, and says so where a document claims more.

## Executive summary

- **Neither repository is an agent framework.** Substrate runs sandboxed processes ("actors") and suspends idle ones to snapshots, so many actors share a few Kubernetes pods (`substrate:README.md:9-11`). `env` is a small service on Substrate that gives each "environment" a shell, file I/O and six MCP tools (`env:README.md:6-12`). Neither has an LLM loop, a prompt, a transcript, compaction or approvals. Most of r6 has no counterpart in them.
- **Their closest match to our delegated identity is `ateom-for-actor`.** The component that carries traffic for an actor (atunnel, inside the worker's ateom) holds a certificate naming both itself as carrier and the actor (`substrate:cmd/ateapi/internal/workerservice/certificate.go:75-83`). The egress gateway checks it, then passes plugins the plain actor identity (`substrate:cmd/atenet/internal/router/egress/credentials.go:79-81`). This is the same split as r6's principal (carrier) and delegation (agent) (r6 §4.7), reached independently. Theirs is cryptographic; ours is attribution only, by decision.
- **Authorization is mostly unbuilt at this commit.** Any authenticated caller has full control of the control plane (`substrate:docs/authentication.md:26-31`). An OpenFGA model is installed at startup (`substrate:cmd/ateapi/main.go:173-179`), but no code asks it for a decision: outside its own package, the `authz` package is referenced only by those startup lines. The credential-minting RPCs carry `TODO(authz)` in place of their checks (`substrate:cmd/ateapi/internal/controlapi/actor.go:600-603`). The API guide describes checks the code does not make (§2.2).
- **Incarnation pinning is the practice that transfers best.** Every identity-bearing request carries the actor's `uid` next to its name, so a request cannot act on a recreation that reused the name (`substrate:docs/api-style-guide.md:467-524`, `substrate:pkg/proto/ateapipb/ateapi.proto:2146-2151`). We should check every key r6 uses for the same reuse problem (lesson 2).
- **A refusal is an answer, and a transport failure is not.** Their suspend request is deliberately not idempotent. A refusal is never retried, and a failure to deliver is retried within a budget sized to how fast the signal goes stale (`substrate:internal/ateomsuspend/ateomsuspend.go:43-58,108-115`). This sharpens r6's late-result and elicitation retry rules (lesson 4).
- **They wrap capability discovery and then skip it.** Substrate consumes CSI drivers and has a wrapper for `GetPluginCapabilities`, but no code calls it; only the driver name is read (`substrate:internal/volume/csi/plugin.go:73-80`). This is evidence for making r6's `role.describe` check part of a shared client that consumers cannot skip, and for testing that consumers refuse (lesson 3).
- **Bounded waits never cancel committed work.** Their router holds a request while a resume is retried, but the budget "bounds retries, not a committed resume" (`substrate:docs/request-parking.md:46-55`). This matches r6's compaction WAIT (r6 §5.5) and the blocking-with-deadline elicitation mode (r6 §11.5). It adds two ideas we lack: a cap on concurrently parked calls, and a shared budget when calls join one flight (lesson 5).
- **Their state model is the opposite of ours.** They snapshot the whole process (memory and disk) and restore it. Anything done since the last snapshot is lost after a crash (`substrate:docs/upgrade.md:205-218`), and they make no at-most-once promise for external side effects (§2.4). r6 records every output in a WAL and replays it without calling anyone again (r6 §2 principle 4, §8). For a coding-agent runner, r6's approach is the one that holds.
- **`env`'s MCP `shell` tool shows the problem r6 solves.** It starts a background process and blocks until it ends. If the caller goes away, the process keeps running and the caller never learned its id (`env:internal/mcp/tools.go:207-268`, `env:guest/process/tracker.go:233`). r6 turns a call blocked on a question into `decision_pending` when its route closes (r6 §11.5) and names a `background_completions` capability for tools that outlive their call (r6 §9.6), though r6 §19 item 9 still leaves that capability undefined.
- **What fits a local CortexKit:** a threat model with testable invariants, incarnation checks, a mandatory describe check, the refusal/failure split, parking caps, and unknown-field preservation in relays. **What fits only a cloud setting:** proxy-side credential injection, per-actor sandboxes and egress default-deny. Proxy injection pulls against r6's position that delegated identity is not a security boundary, and sandboxing against AFT running commands in unapproved projects; §3 (lessons 10 and 11) argues both sides.

## 1. What each system is and does

### 1.1 Substrate

**Purpose.** Substrate "maps a larger set of 'actors' (applications such as agents) onto a smaller set of ready 'workers'", relying on agents being idle most of the time (`substrate:README.md:9`). It calls itself "low-opinion" and "not an SDK for building agents" (`substrate:README.md:11`). Its stated targets are cluster-scale: 100 ms p95 activation, a billion actors, 1000 wakeups a second (`substrate:docs/architecture.md:106-119`). It is pre-1.0 with no compatibility promise (`substrate:README.md:46-50`).

**Components** (`substrate:docs/glossary.md:52-78`, `substrate:docs/architecture.md:305-367`):

| Component | Role |
|---|---|
| `ate-api-server` (`cmd/ateapi`) | Control plane. Actor records, scheduling, lifecycle workflows, credential minting. State in PostgreSQL. |
| `atecontroller` | Reconciles the `WorkerPool` CRD into a Deployment of warm worker pods. |
| `atelet` | Per-node DaemonSet. Pulls images, drives sandboxes through ateom, moves snapshots to and from object storage. |
| `ateom` (`ateom-gvisor`, `ateom-microvm`) | Runs inside each worker pod and drives the sandbox runtime. Embeds `atunnel`, which carries the actor's network traffic. |
| `atenet` | Router. Envoy (or agentgateway) plus an `ext_proc` service that resumes actors on demand and routes to them. Also the egress gateway. |
| `podcertcontroller` | Issues short-lived pod certificates used for mTLS between components. |

**Resources.** `WorkerPool` and `SandboxConfig` are Kubernetes CRDs owned by admins. `ActorTemplate` (image, resources, snapshot policy) and `Actor` records live in the control-plane database, not in Kubernetes (`substrate:docs/glossary.md:8-50`). An `Atespace` is the naming and isolation scope: an actor is addressed by `(atespace, name)` (`substrate:docs/glossary.md:36-41`).

**How a run starts.** `CreateActor` only writes a record in state `SUSPENDED`, pointing at the template's golden snapshot (`substrate:docs/architecture.md:427-438`). The actor first runs when traffic arrives: a client sends a request to the router with `ate-target-actor: <atespace>/<actor>`, the router's ext_proc calls `ResumeActor`, the control plane claims a warm worker, atelet has ateom restore the snapshot, and the router forwards the request over mTLS to atunnel on the worker (`substrate:docs/architecture.md:384-409`, `substrate:cmd/atenet/internal/router/ingress/ingress.go:90-162`). `ResumeActor` can also be called directly.

**How it is hosted and isolated.** Each actor runs in its own sandbox inside a worker pod: gVisor (`runsc`) by default, or a Kata/Cloud Hypervisor micro-VM (`substrate:docs/architecture.md:332-338`). ateom gives the active actor a private point-to-point veth network. Ingress enters only through atunnel's authenticated listener (`substrate:docs/threat-model.md:41-43`). Egress goes through a gateway that enforces a per-actor `EgressPolicy` (§2.6).

**How it stops.** `SuspendActor` checkpoints memory and disk, uploads the snapshot, wipes the worker and returns it to the pool (`substrate:docs/architecture.md:459-474`). `PauseActor` keeps the snapshot on the node for a faster resume there. If a lifecycle step fails the actor goes to `CRASHED`, which blocks resume and suspend until `RevertActor` discards the crashed run and returns to the last completed snapshot (`substrate:docs/architecture.md:483-487`, `substrate:docs/upgrade.md:205-218`). Suspension is explicit today. A worker-initiated path exists (`RequestActorSuspend`: "the worker observes; the control plane decides", `substrate:cmd/atelet/ateomsupport.go:123-157`), but no code outside its own package calls the requester in `internal/ateomsuspend` at this commit.

### 1.2 `env`

**Purpose.** "An environment service on top of Agent Substrate: isolated, stateful execution environments driven remotely with command execution, filesystem operations, and built-in MCP tools." Each environment is one Substrate actor (`env:README.md:6-12`).

**Parts** (`env:README.md:27-31`):
- `ate-env-api`: a gRPC and HTTP server. Its `EnvironmentService` (create, get, suspend, delete; `env:proto/ateenv/v1alpha/env.proto:37-49`) translates into Substrate `Control` calls. Its process and file RPCs are proxied to the guest through the Substrate router.
- `ate-env-guest`: a daemon inside the actor serving `ProcessService` (start, get, stream output, kill) and `FileSystemService` (streamed read and write) (`env:proto/ateenv/v1alpha/guest.proto:34-57`).
- An MCP endpoint at `POST /v1alpha/envs/{id}/mcp` with six tools: `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `shell` (`env:README.md:181-194`). The README says the guest serves the MCP tools (`env:README.md:29`), but the handler is mounted in `ate-env-api` (`env:cmd/ate-env-api/main.go:70`), and each tool calls the guest's gRPC services (`env:internal/mcp/server.go:54-61`).
- Go and Python clients, and a CLI.

**Relation to Substrate.** `env` uses Substrate only as a client. Its `go.mod` depends on `github.com/agent-substrate/substrate` at an older pseudo-version (`env:go.mod:6`), and it imports only the public `pkg/proto/ateapipb` and `pkg/api/v1alpha1` packages. It creates actors through `Control.CreateActor` (`env:internal/ate/client.go:241-272`) and reaches the guest by sending gRPC through the router with the `ate-target-actor` header set (`env:internal/ate/client.go:158-198`). This fits Substrate's own rule for integrations: non-trivial integrations live in their own repository and build against released core, never a patched one (`substrate:docs/integration-repos.md:8-12,98-123`).

### 1.3 What neither one is

Neither repository contains a model call, a prompt, a transcript, a tool-approval step or anything about context size. A search of both trees for compaction, transcript, elicitation and approval terms found only unrelated uses: governance text, the repository's own maintenance skills for coding agents, a pod-certificate comment and a meeting-recordings link. The Claude Code demo simply runs `claude --print` inside an actor on a loop (`substrate:demos/claude-code-multiplex/workload/run.sh:46`). Substrate is the layer under an agent harness; `env` is a tool server. The comparisons below therefore fall into three kinds: places where they solve the same problem at a different layer, places where their infrastructure habits carry over, and places where they have nothing to compare.

## 2. How they handle the problems we are solving

Each subsection says what they do, where, and how it compares with r6.

### 2.1 Pluggable components and interfaces

Substrate has four places where one implementation can be swapped for another. None of them has anything like our `role.describe` or a per-role conformance suite.

**The sandbox runtime (`Ateom`), a CRI-like interface.** The control plane and atelet drive every sandbox class through one internal gRPC service: `RunWorkload`, `CheckpointWorkload`, `RestoreWorkload`, `TerminateWorkload`, and two stats reads (`substrate:internal/proto/ateompb/ateom.proto:34-107`). One `ateom` image exists per class (`ateom-gvisor`, `ateom-microvm`), selected by the `WorkerPool`'s `sandboxClass` (`substrate:docs/architecture.md:332-338`). Two details are worth noting:
- *The implementation reports what it can supply.* `SetWorkerCapacity` is described as "the Worker's to report rather than the control plane's to infer: it is what the ateom can actually supply, only its node can observe it, and a fleet may run mixed ateom versions". The report replaces the recorded set rather than merging into it: "a dimension left out is one the Worker no longer supplies" (`substrate:pkg/proto/ateapipb/ateapi.proto:2038-2045,2083-2088`).
- *Versions are pinned to the saved state.* Sandbox binaries come from a `SandboxConfig` and "are pinned into each snapshot's manifest so restores stay reproducible across runtime upgrades" (`substrate:docs/architecture.md:334`). `RestoreWorkload` fetches the runtime version that matches the checkpoint (`substrate:internal/proto/ateompb/ateom.proto:44-47`).

**Storage, through CSI.** Substrate talks to CSI drivers directly, found through a `CSIDriverConfig` CRD naming each driver's endpoints (`substrate:docs/csi-volumes.md:15-40`). Internally it narrows CSI to a small interface, `VolumePluginControlPlane` (create, delete, attach, detach) plus a worker-side mount interface (`substrate:internal/volume/plugin.go:22-34`). It reads the driver's name with `GetPluginInfo` (`substrate:internal/volume/csi/plugin.go:73-80`). The client also wraps `GetPluginCapabilities` and `Probe` (`substrate:internal/volume/csi/identity.go:28-35`), but nothing outside that file calls them. In short, Substrate consumes a capability-negotiating protocol and skips the negotiation.

**Credential providers, a one-RPC plugin API.** `CredentialProvider.FetchSecret(uri, actor_spiffe_id) → opaque_bytes` is "the plugin API a secret backend implements so Substrate infrastructure ... can fetch an external credential without Substrate storing it" (`substrate:pkg/proto/credproviderpb/credprovider.proto:21-47`). A credential is named by a URI, `ate-secret://<provider>/<provider-specific tail>`. The gateway serves one configured provider, and a URI naming any other provider fails closed before any call (`substrate:cmd/atenet/internal/router/egress/credentials.go:91-108`, `substrate:cmd/atenet/internal/router/egress/provider.go:84-112`). Provider errors are mapped by kind: NotFound and PermissionDenied become a permanent 403, Unavailable and DeadlineExceeded a retryable 503, and anything unexpected a 403 (`substrate:cmd/atenet/internal/router/egress/credentials.go:33-49`). The shipped provider reads Kubernetes Secrets under a default-deny map from atespace to allowed namespaces (`substrate:cmd/credential-provider/kubernetes-secrets/nsauthz.go:36-105`).

**The proxy, behind the `ext_proc` contract.** The router runs either Envoy or agentgateway in front of the same ext_proc service (`substrate:cmd/atenet/internal/router/dataplane.go:51-61`). The Go handlers accept the client certificate from either proxy's attribute (`substrate:cmd/atenet/internal/router/egress/egress.go:287-304`). The stable part is the callout protocol, not the proxy.

**Versioning and validation.**
- Public APIs are `v1alpha1` (CRDs) and `v1alpha` (`env`), and pre-1.0 carries no compatibility promise (`substrate:README.md:46-50`, `env:README.md:3-4`).
- Every field of every API is declared `+k8s:required` or `+k8s:optional`, and validation is generated from comment tags by Kubernetes' `validation-gen` (`substrate:docs/api-validation.md:8-18,96-103`). The stated rule is "Be strict! It is easier to loosen validation than to tighten it" (`substrate:docs/api-validation.md:74-78`). Using an alpha or beta validation tag requires an explicit acknowledgement tag (`substrate:docs/api-validation.md:85-94`).
- Every resource has an int64 `version` that rises on every write and an immutable `uid`. Updates must echo both, and a mismatch is `ABORTED` (`substrate:docs/api-style-guide.md:438-524`).
- Clients must "modify what you read, do not reconstruct it", and must not round-trip through JSON, so that fields a newer server added survive an update from an older client (`substrate:docs/api-style-guide.md:500-502`).

**Compared with r6 §3.**
- *Discovery before use (r6 §3.3).* They have no equivalent. The CSI case shows what happens without one: the negotiation call exists and nobody makes it. r6's rule that the consumer calls `role.describe` and refuses a module missing required ops is stronger than anything here.
- *Versions (r6 §3.4).* Their snapshot pins the runtime version that wrote it, which is the same idea as r6's "a session keeps its role version for life". Their "replace, never merge" capacity report is r6 §3.6's "pushed sets carry full state and a generation", without the generation.
- *Strict and lenient.* They are strict on everything they accept and store. r6 is lenient when decoding `role.describe` (unknown ops and fields are ignored) and strict only on the presence of required ops. There is no contradiction: they validate requests they will persist, and r6 decodes a peer's self-description for forward compatibility. Their unknown-field rule for clients is the counterpart of our lenient decoding, and r6 does not state it (lesson 7).
- *Conformance (r6 §3.5).* I found no per-plugin conformance kit. Their tests are package tests and cluster end-to-end suites (`substrate:AGENTS.md:49-52`).

### 2.2 Agent and actor identity

**The identities.** An actor is `(atespace, name)` at a point in time, plus a `uid` that is unique across time (`substrate:docs/api-style-guide.md:467-475`). Substrate mints two kinds of credential for it:
- *Actor JWT* (`Control.MintActorJWT`): an OIDC-compatible token with subject `atespaces:<atespace>:actors:<name>`, a required audience, a 15-minute lifetime, and the atespace, name and uid in a private `ate.dev` claim (`substrate:cmd/ateapi/internal/controlapi/actor.go:595-647`, `substrate:pkg/proto/ateapipb/ateapi.proto:1543-1592`). The proto says the egress gateway calls it to inject the actor's identity into outbound requests (`substrate:pkg/proto/ateapipb/ateapi.proto:66-69`). At this commit nothing in the repository calls it.
- *Actor certificate* (`Control.MintActorCertificate`): a one-hour X.509 certificate with SPIFFE ID `spiffe://substrate-actor.local/actor/<atespace>/<name>`. It is only issued to a caller that authenticated with a client certificate, "we should not allow bootstrapping a proof-of-possession credential from a bearer credential" (`substrate:cmd/ateapi/internal/controlapi/actor.go:655-716`).

**The carrier identity, `ateom-for-actor`.** The credential that is actually used today belongs to the carrier. `WorkerService.MintAteomActorCertificate` "asserts an ateom acting on behalf of a particular actor", with SPIFFE ID `spiffe://substrate-actor.local/ateom-for-actor/<atespace>/<name>` (`substrate:pkg/proto/ateapipb/ateapi.proto:2047-2051`, `substrate:cmd/ateapi/internal/workerservice/certificate.go:37-101`). The chain is:
1. atunnel, running in the worker's ateom and outside the sandbox, generates a private key per activation. The key "never leaves atunnel; only its CSR crosses the credential broker socket" (`substrate:internal/atunnel/credential.go:70-102`).
2. atunnel sends the CSR over a Unix socket to the node's atelet, authenticated with the worker pod's certificate (`substrate:internal/atunnel/credential.go:104-130`). atelet checks that the caller is a worker pod (`substrate:cmd/atelet/ateomsupport.go:37-47,62-76`).
3. atelet forwards it to the control plane, which accepts it only from atelet's SPIFFE ID ("everything else with a valid pod-identity certificate — including the actor workloads themselves — is rejected", `substrate:cmd/ateapi/internal/ateletauth/ateletauth.go:44-68`), checks that the actor exists with that uid, and signs (`substrate:cmd/ateapi/internal/workerservice/certificate.go:44-96`).
4. When the actor makes an outbound request, atunnel opens the egress CONNECT with that certificate. The gateway re-verifies the chain against the actor-identity CA, refuses CA certificates, requires exactly one URI SAN in the `ateom-for-actor` form, and checks with the control plane that the actor still exists and is `RUNNING` (`substrate:cmd/atenet/internal/router/egress/egress.go:263-355`). The handler's comment sums up the rule: "Nothing the actor can write contributes to the identity" (`substrate:cmd/atenet/internal/router/egress/egress.go:133-136`).
5. Before calling a credential provider, the gateway translates the carrier's identity into the plain actor identity "for plugins to make decisions on" (`substrate:cmd/atenet/internal/router/egress/credentials.go:79-81`).

**What is missing at this commit.**
- No authorization. The control plane authenticates callers by mTLS or JWT, but "Authorization and RBAC are not implemented yet", so any configured provider's users have "full control of the entire control plane" (`substrate:docs/authentication.md:26-31`). An OpenFGA model with relations such as `can_mint_ateom_actor_credential: host_node` exists (`substrate:cmd/ateapi/internal/authz/model.fga:76-99`) and is installed at startup (`substrate:cmd/ateapi/main.go:173-179`), and there is plumbing to write its tuples in the same PostgreSQL transaction as resource changes (`substrate:cmd/ateapi/internal/authz/datastore.go:40-72`). No code asks the OpenFGA model for a decision: outside its own package, the `authz` package is referenced only by the startup lines above.
- The minting paths carry `TODO(authz)` and `TODO(identity)` where the checks would go. atelet does not check that the calling ateom hosts the actor it asks about (`substrate:cmd/atelet/ateomsupport.go:44-46`). The control plane checks only that the actor exists with that uid, not that it runs on that node (`substrate:cmd/ateapi/internal/workerservice/certificate.go:44-64`).
- The documentation says more than the code. The API guide says the broker signs only if the actor is currently running, and its worker is on the caller's node and still assigned to it, with a SPIFFE URI of `.../atespace/<atespace>/actor/<name>` (`substrate:docs/api-guide.md:548-567`). The code checks existence and uid only, and builds `.../actor/<atespace>/<name>` (`substrate:internal/resources/spiffe.go:33-39`). The threat model lists the missing check as critical T-28: "Ensure that credential issuance checks actor-to-worker scheduling assignment" (`substrate:docs/threat-model.md:107`). A test that asks an atelet on one node for a certificate for an actor running on another would settle this; I did not run one.

**Compared with r6 §4.7 (delegated identity).**

| Question | Substrate | r6 |
|---|---|---|
| Who names the carrier? | The mTLS certificate chain, issued through atelet (steps 1–3). | The daemon stamps the route principal (`reserved:<id>` after a launch-nonce proof, else `direct`) (r6 §4.7, §4.7.1). |
| Who names the agent? | The same certificate: `ateom-for-actor/<atespace>/<name>`. | A separate binding registered by Prefrontal with `delegation.sync`, stamped by the daemon at `route.open` (r6 §4.7.1–4.7.2). |
| When is it fixed? | At connection (TLS handshake) and again at CONNECT. | At `route.open`; frozen at bind; never per call (r6 §4.7.2). |
| What do plugins see? | The plain actor identity, carrier stripped (`credentials.go:79-81`). | `delegation: {agent_id, scope, session_ref}` next to the principal. Providers check both the carrier's module grant and the agent's grant (r6 §4.7.3). |
| Does the body count? | Never. The gateway reads identity only from the certificate. | Never. "Nothing travels in the call" (r6 §4.7). |
| Is it a security boundary? | Intended to be (`substrate:docs/roadmap.md:59-66`), though authorization is not built. | No. "It identifies the agent ... It is not a security boundary" (r6 §4.7). |
| Name reuse? | Every request carries the actor `uid`; a recreated actor is refused with ABORTED. | Bindings are keyed by `session_ref`; generations guard the pushed set and the grant (r6 §3.6, §4.7.3). No incarnation for `agent_id` (lesson 2). |
| Revocation | Short-lived credentials (15 min, 1 h) plus a live "still running" check at the gateway. | Removal from the set drains routes; a grant revoke takes effect on the next call (r6 §4.7.1, §4.7.3). |

The shapes agree. Both systems separate "who carries the call" from "whom it is for", stamp both outside the agent's reach, and let the leaf service decide on the agent. The differences follow from deployment. Their carrier is a process they launched on hardware they control, so they can give it a key. Our `direct` carrier is a harness plugin that holds only a connection-file key (r6 §4.7.5), which is why r6 treats delegation as attribution. Their design does not suggest r6 should drop its attribution-only ruling for a single-user machine (§3, lesson 10).

### 2.3 Tool execution: approval, long-running calls, results

**Substrate** has no tools and no approvals. The nearest things are how it handles a caller that has to wait, and how it treats a request that may not be repeated.

*Request parking* (`substrate:docs/request-parking.md`). When a resume cannot get a worker, the router holds ("parks") the inbound request and retries the resume with backoff until it succeeds or a budget runs out (default 5 s):
- "The budget bounds retries, not a committed resume." When the budget runs out the router starts no new attempt, but an attempt already in flight is never cancelled, because "the control plane has committed work to it". If the restore takes longer than the budget, the request is "served late rather than failed" when the restore completes (`request-parking.md:46-55`).
- Concurrent requests for one actor join one in-flight resume, so a hot actor costs one control-plane call. The budget belongs to the flight, not the request, so a late joiner inherits what is left (`request-parking.md:90-102`).
- Parked requests take a slot in a fixed-size lot (default 1024). When the lot is full, the next request that would park is shed with a named 503, "router at capacity", instead of queueing without bound (`request-parking.md:67-74`).
- Only transient errors park. NotFound, DeadlineExceeded and permission errors fail at once (`request-parking.md:104-120`).
- Each wait is measured exactly once with an outcome label: `served`, `budget_exhausted`, `canceled`, `timeout`, `error` (`request-parking.md:156-170`).

*A request that must not be repeated.* `RequestActorSuspend` is "not idempotent, unlike `Control.SuspendActor`": after a granted suspend the worker no longer hosts the actor, so a retry is refused as NotFound, and "a Worker that retries a suspend it had already been granted therefore sees a failure rather than a repeat of its success" (`substrate:pkg/proto/ateapipb/ateapi.proto:2053-2072`). The requester treats a refusal as an answer and never retries it. It retries a delivery failure only about six times over some fifteen seconds, because "an idleness signal is a fact about the past, and it decays" (`substrate:internal/ateomsuspend/ateomsuspend.go:43-58,104-115`).

**`env`** has asynchronous process RPCs, but its MCP `shell` tool waits for completion and never returns the process handle.
- `ProcessService.StartProcess` returns a `process_id` at once. `GetProcess` reads status and exit code. `StreamProcessOutputs` reads stdout and stderr from byte offsets, optionally following, and `KillProcess` kills the process group (`env:proto/ateenv/v1alpha/guest.proto:34-151`).
- The guest's tracker bounds everything: 10 concurrent processes, a 10 MB cap per output stream with a visible truncation line, a one-hour watchdog kill, and completed records kept for one hour or at most 100 (`env:guest/process/tracker.go:36-49,165-198,272-277`). The process table is an in-memory map, with logs spooled to files (`env:guest/process/tracker.go:113-120,217-231`).
- The process is started with `exec.Command`, not tied to the RPC's context, in its own process group (`env:guest/process/tracker.go:233,251`). It outlives the call that started it.
- The MCP `shell` tool does not expose any of this. It starts the process, follows its output to the end, reads the exit code and returns one text result (`env:internal/mcp/tools.go:177-268`). If the MCP caller disconnects or its context is cancelled, the tool returns an error, the process keeps running for up to an hour, and the caller never received the `process_id` that would let it read the result or kill it.
- The tool registry refuses duplicate tool names at registration, lists definitions in sorted order, turns errors and panics into `IsError` results, and answers an unknown tool with the list of available names (`env:internal/tool/tool.go:56-132`).
- Nothing asks a human, and nothing stops a call before it runs.

**Compared with r6.**
- *Elicitation (r6 §11).* Neither system has anything like it. r6's three modes, `dedup_key`, argument-digest binding and `late_execution` have no counterpart to compare against.
- *Blocking with a deadline (r6 §11.5) and compaction WAIT (r6 §5.5).* Parking is the same shape: hold the caller for a bounded time, never abandon work already committed, then answer with a named outcome. r6 already has the key rule ("the provider decides between a normal result and `decision_pending` once, under one lock"). Parking adds two things r6 does not state: a cap on how many calls may be held at once, with a named refusal when it is full, and what budget a call gets when it joins one already waiting (lesson 5).
- *Late results (r6 §11.7).* `env`'s offset reads and bounded retention are a small version of r6's bounded late-result log with a cursor. The difference is durability: `env`'s table lives in process memory. It survives a suspend only because a full snapshot saves the memory. `env`'s template sets no snapshot scope (`env:cmd/ate-env/manifest.go:273-305`), and at Substrate's current commit an unset scope means FULL (`substrate:pkg/proto/ateapipb/ateapi.proto:885,895`). `env` pins an older Substrate, so suspending an environment with a running process and resuming it would settle the question. A crash of the guest loses the table either way.
- *The orphaned `shell` call* is the kind of failure r6 §11.5 prevents for calls blocked on a question: when the route closes without a cancel, the provider converts the blocking call to `decision_pending` and the owner can still read the result. For a long-running command the r6 counterpart is the `background_completions` capability (r6 §9.6), which r6 names but does not yet define (r6 §19 item 9). `env` shows the requirement it has to meet: a tool that can outlive its call has to hand back a handle.
- *Duplicate names.* `env` refuses a duplicate at registration. r6 refuses a collision at admission and names both tools (r6 §4.5). Same rule, different point.

### 2.4 Session and run state

**What is durable.**
- *Control-plane state* (actors, workers, templates, tags, egress policies) is in PostgreSQL. Every write carries a version precondition (`substrate:cmd/ateapi/internal/controlapi/workflow.go:73-86`).
- *Actor state* is a snapshot. A `Full` snapshot is process memory, the root filesystem's changes and any `DurableDir` volumes. A `Data` snapshot is only the volumes (`substrate:docs/glossary.md:109-151`). An actor owns one external snapshot at a time; a tag takes its own copy so it outlives the actor (`substrate:docs/architecture.md:469-481`).
- *Nothing about an agent's conversation* is stored by Substrate. If the harness in the actor keeps a transcript, it is part of the snapshot like any other file or memory page.

**Resuming after a crash.**
- *The workflows use an "ensure" pattern.* "Each step derives whether its work is already done from persisted state alone (calling markSkipped when so), validates the state-machine edge it is about to take, and persists what it changed before returning — so a re-entered workflow fast-forwards to wherever the previous attempt stopped." A skipped step is marked on its trace span with the reason (`substrate:cmd/ateapi/internal/controlapi/workflow.go:41-71`). `ResumeActor` is written as a chain of such steps under a per-actor lease (`substrate:cmd/ateapi/internal/controlapi/workflow_resume.go:65-136`).
- *A failed actor is sealed.* A failed lifecycle step moves the actor to `CRASHED` with a recorded reason and frees its worker (`substrate:cmd/ateapi/internal/controlapi/crash.go:31-113`). In that state resume and suspend are both refused, "and everything since its last snapshot is lost". Only an explicit `RevertActor` discards the crashed run and returns to the last completed snapshot (`substrate:docs/upgrade.md:205-220`, `substrate:docs/architecture.md:483-487`).

**At-most-once side effects.** Substrate makes no such promise for what an actor does; I found none in its documents or APIs. Restoring a snapshot rewinds the actor's memory and disk to the moment it was taken (`substrate:docs/architecture.md:491-507`). Any external effect the actor caused after that moment (a push, an API call, a message) has happened, but the restored actor does not know it did. Substrate's own lifecycle calls are protected by version preconditions, leases and uid pins (`substrate:cmd/ateapi/internal/controlapi/workflow.go:76-80`, `substrate:cmd/ateapi/internal/controlapi/workflow_resume.go:99-103`), which is at-most-once for its own bookkeeping only.

**Transcript storage and reads.** None.

**Compared with r6.**
- *Resume (r6 §8) and the crash harness (r6 §3.5).* The ensure pattern and r6's "replay the record, never call the module again" rest on the same rule: progress is read from durable state, not from memory. r6 is stricter where it matters for agents. It records each output before its effect is visible (r6 §6.3), writes `ToolDispatchIntent` before a tool executes (r6 §8), and reports an uncertain outcome instead of retrying it (r6 §11.6). Snapshot restore cannot give those guarantees. A Broca run inside a Substrate actor would keep its guarantees only because its WAL lives in the snapshotted filesystem and a restore rewinds the WAL together with the process. Effects on other machines after the snapshot would still be invisible to it.
- *Terminal states.* Their `CRASHED` needs an explicit revert (`substrate:docs/upgrade.md:213-218`). r6 seals a cut run `Interrupted`, and the caller resumes by sending again (r6 §5.5, §3.5). r6's WAL makes a resend safe where Substrate's snapshot does not. The one case where Substrate's stricter stance has something to teach us is a run with an indeterminate tool call (r6 §10.2): lesson 9.
- *Trace markers.* r6 has an observe stream (r6 §12.3) but does not say that resume should record, step by step, what it replayed and what it redid. Substrate's `markSkipped` does exactly that (lesson 6).

### 2.5 Context and prompt management

Neither repository manages model context. There is no compaction, no prompt-cache handling and no prefix-stability rule. The only incidental overlap is that `env`'s registry returns tool definitions sorted by name (`env:internal/tool/tool.go:91-98`), which gives stable bytes across calls. r6 §4.2 makes the same property a requirement ("stable key order, and no timestamps, counters or random ids") and checks it through digests.

r6 §4–§7 and §13 (preflight, the frozen manifest, compaction providers, step transforms, breakpoints, change policies) have no counterpart in either repository.

### 2.6 Sandboxing and trust

**Isolation.** Every actor runs in a gVisor or micro-VM sandbox (`substrate:docs/architecture.md:332-338`). The threat model's first rule for actors is "Traditional containers are not a secure sandbox" and "sandbox lifecycle must be controlled from outside the sandbox" (`substrate:docs/threat-model.md:94`). The actor gets a private veth network; ingress comes only through atunnel's mTLS listener (`substrate:docs/architecture.md:351-355`).

**Egress.** Each actor may have one `EgressPolicy`. Rules are evaluated in order, the first match authorizes, and "a request is denied when no rule matches" (`substrate:pkg/proto/ateapipb/ateapi.proto:398-419`). A hostname rule may inject a credential into a request header. The gateway terminates TLS to do it, and it overwrites any value the actor set so the actor cannot pre-seed it (`substrate:cmd/atenet/internal/router/egress/credentials.go:51-136`). The denial body the actor sees is only "egress denied"; the reason goes to the log (`substrate:cmd/atenet/internal/router/egress/egress.go:75-77`). Two gaps are documented in the same code: injection is silently skipped on a cleartext leg or when no provider is configured, and the request goes out without the credential (`credentials.go:55-77`). The gateway also has a `TODO(identity)` to check that the actor cannot overwrite the forwarded-certificate header (`egress.go:63-69`).

**Credentials in the sandbox.** Threat T-29: "Agent leaks credentials exposed in sandbox, because LLMs are unreliable". The mitigation is "credentials are not exposed in sandboxes by default", with an injecting proxy as the suggested route (`substrate:docs/threat-model.md:108`), and injection through proxies is on the roadmap (`substrate:docs/roadmap.md:65`). Their own Claude Code demo does the opposite and puts `ANTHROPIC_API_KEY` into the actor's environment as a plain value (`substrate:demos/claude-code-multiplex/agent-luna-template.yaml.tmpl:21,41-42`).

**How trust is decided.**
- *Admins* choose runtimes. The threat model wants runtimes configurable only by administrators (T-07, `substrate:docs/threat-model.md:76`).
- *Callers of the control plane* are trusted if they authenticate at all (`substrate:docs/authentication.md:26-31`).
- *Actors* are untrusted by default: they cannot reach the minting RPCs (`substrate:cmd/ateapi/internal/ateletauth/ateletauth.go:60-68`), and nothing they write enters their identity.
- *`env`* adds no trust layer. `ate-env-api` has no caller authentication. It picks the environment from an `x-env-id` header (`env:internal/apiservice/server.go:340-355`), dials the router without TLS (`env:internal/ate/client.go:181-183`), defaults to skipping certificate verification on its control-plane connection (`env:cmd/ate-env-api/main.go:41`), and creates atespaces on demand with its own credentials (`env:internal/ate/client.go:213-230`). Any client that reaches it acts with its full authority. The guest confines file operations to a root directory by a path-prefix check (`env:guest/filesystem/service.go:94-108`). Processes are not confined inside the sandbox, which is expected: the sandbox is the boundary.

**Compared with r6 §4.6 (project trust).** The two answer different questions. Substrate asks whether code may escape its sandbox, and its answer is the sandbox itself. r6 asks whether a repository's own configuration may act (shell auto-approval, write tools, data-leaking endpoints), and its answer is an approval record in entorhinal, checked at call time, never changing the prefix (r6 §4.2, §4.6). r6 runs tools on the user's own machine without a sandbox. AFT "never asks for trust": the command runs, and only the project's own output filters are skipped (r6 §4.6). Nothing in Substrate argues against that for a local tool, but its egress and credential rules raise the question of whether a CortexKit session on an unapproved project should get a narrower shell environment (lessons 10 and 11).

### 2.7 Multi-agent orchestration and routing

Routing to a named target is done with the `ate-target-actor` header. I found no other routing mechanism for actors in either repository.

**Ingress.** A higher-level system sends a request to the router with `ate-target-actor: <atespace>/<actor>`. `Host` "remains application authority and does not select the Actor" (`substrate:docs/architecture.md:344-349`). The router:
1. parses the header, falling back to proxy filter state (`substrate:cmd/atenet/internal/router/ingress/ingress.go:90-93`);
2. resumes the actor, parking if needed (§2.3), and learns its worker (`ingress.go:109-132`);
3. overwrites the header with the resolved value, "so a client-provided value cannot select a different actor after this request has been resolved" (`ingress.go:153-162`);
4. connects to the worker's atunnel over mTLS.

atunnel checks the header again against the actor it is currently hosting. On a mismatch it answers 421 Misdirected Request with a stale-assignment header (`substrate:internal/atunnel/ingress.go:518-557`). It strips the routing header before the request reaches the actor (`substrate:internal/atunnel/ingress.go:175-177`). Other ports are reached with HTTP `CONNECT`, and each request inside the tunnel is routed again, so an actor that moves workers is followed (`substrate:docs/architecture.md:357-365`).

**Actor to actor.** Not built. The roadmap lists "actor-to-actor routing through explicit actor-reference headers" and an "Actor-to-Actor (A2A) calling model" (`substrate:docs/roadmap.md:47,97`), and delegating downscoped rights to children and peers (`substrate:docs/roadmap.md:126`). The threat model asks for default-deny between actors and limits on child actors (T-17, T-33, `substrate:docs/threat-model.md:96,112`).

**Orchestration.** None. Nothing decides which agent gets which task. The Claude Code demo hands tasks to idle agents from a small web UI and talks to the control plane directly, not through the router (`substrate:demos/claude-code-multiplex/README.md:1-20`).

**Compared with r6.** The routing header plays the part of `session_ref` on `route.open` (r6 §4.7.2): the target is named once per connection or route and resolved by infrastructure, not by the body. Two habits match r6 already: the resolver overwrites what the client supplied, and the receiving end checks again. Their 421 with a stale-assignment marker is the same idea as r6's retryable `target_unavailable` with `delegation_not_registered` (r6 §4.7.2): a named refusal that tells the caller to resolve again instead of failing. Prefrontal's orchestration of heads and workers (r6 §4.7.4) has no counterpart.

## 3. Lessons for CortexKit, ranked

Ranked by value to a local, single-user CortexKit against cost. Each lesson names the idea, where it is in their code, what in r6 it would change or strengthen, the cost, and where it fits. Lessons 10 and 11 contradict r6 decisions; both sides are argued there. Section 3.1 lists the places where they only confirm r6.

**1. Write a threat model for r6 as a table of threats and testable invariants.**
- *Idea.* Each row is a threat, a priority, a "mitigating invariant" that states a property which, if true, removes the threat, and suggested mitigations. The document says outright that security-review skills for AI-assisted review should be extracted from it (`substrate:docs/threat-model.md:12-15,51-57`).
- *Where.* `substrate:docs/threat-model.md` (43 threats) and its machine-readable twin `substrate:docs/threats.json`.
- *What it changes.* r6 argues its security positions in prose across §4.3 (system text authority), §4.6 (project trust), §4.7 (delegation), §11.2 (elicitation authority) and §15 (standing rules). A table would make each claim checkable, for example "a cloned repository has no path to system text", "a `direct` carrier can be attributed as a head it names" (accepted, r6 §4.7.5), "late results are served only to the recorded owner". The accepted risks become visible rows instead of sentences.
- *Cost.* A few hours of writing; review from the owners in r6 §3.7.
- *Fit.* Local. It costs nothing at run time, and our fleet already runs agent reviewers that could use it.

**2. Pin incarnations, not just names.**
- *Idea.* A name is unique at a point in time; a `uid` is unique across time. Every request that acts on something by name also carries the `uid` it saw, and a mismatch is refused. This closes the ABA case where a stale request hits a recreation that took the same name (`substrate:docs/api-style-guide.md:467-524`). They apply it to credential minting (`substrate:pkg/proto/ateapipb/ateapi.proto:1551-1556,2106-2111`) and to worker-initiated suspends (`substrate:pkg/proto/ateapipb/ateapi.proto:2146-2151`, `substrate:internal/ateomsuspend/ateomsuspend.go:96-103`).
- *What it strengthens.* r6 keys several things by names that could be reused:
  - the delegation binding is keyed by `session_ref` and names an `agent_id` (r6 §4.7.1), and agents are "retired or merged" (r6 §4.7.4). A provider's per-agent grants and caches are keyed by `agent_id` (r6 §4.7). If an `agent_id` can ever name a new agent after a retirement or merge, those caches carry over.
  - the late-result log is keyed `{bound session, tool_call_id, event_id}` (r6 §11.7). If a Thalamus launch token or an OpenCode session id is reused, a result could land under the wrong session.
  - elicitation `dedup_key` updates an open request in place (r6 §11.3).
  
  The work is an audit: for each key, can it be reused? If yes, add an incarnation (a binding id, an agent generation, a session creation ordinal) and refuse on mismatch. r6 already pins the grant generation at reservation (r6 §4.7.3) and uses `{daemon_incarnation, seq}` cursors (r6 §4.2), so the pattern is familiar.
- *Cost.* Small: one field per key where reuse is possible, and one refusal code.
- *Fit.* Local. Name reuse happens on one machine as easily as in a cluster.

**3. Make the describe check impossible to skip, and test that consumers refuse.**
- *Idea / evidence.* Substrate wraps CSI's `GetPluginCapabilities` and `Probe` and never calls them (`substrate:internal/volume/csi/identity.go:28-35`, `substrate:internal/volume/csi/plugin.go:73-80`). A negotiation step that each consumer writes by hand gets left out.
- *What it strengthens.* r6 §3.3 puts the `role.describe` check in each consumer (Prefrontal, Magic Context, Broca) and r6 §3.5 tests providers. Nothing tests that a consumer refuses a module that lacks a required op. Two changes:
  - ship the check in the shared SDK named in r6 §3.8, as the only way to get a typed client for a role. Routing to a role without going through it should not compile or should fail at startup;
  - add a consumer-side case to each role's conformance kit: present a module that claims the role but lacks one required op, and require a named refusal before any call.
- *Cost.* Small in the SDK; one test per role.
- *Fit.* Local.

**4. Treat a refusal as an answer and a delivery failure as retryable, with a retry budget sized to how fast the signal goes stale.**
- *Idea.* `RequestActorSuspend` is deliberately not idempotent. The caller never retries a refusal, and retries a failure to deliver only for about fifteen seconds, because the idleness it reports "is a fact about the past, and it decays" (`substrate:internal/ateomsuspend/ateomsuspend.go:43-58,104-115`, `substrate:pkg/proto/ateapipb/ateapi.proto:2066-2071`). The atelet passes the control plane's error through unwrapped, "so a worker can tell a decision from a failure to ask" (`substrate:internal/proto/ateletpb/atelet.proto:42-44`, `substrate:cmd/atelet/ateomsupport.go:123-130`).
- *What it strengthens.* r6 has several signals that go stale and several requests where a retry could double an effect:
  - `no_active_device` (r6 §11.5, ~35 s) and the bus change hints (rulings §2 item 4) are facts about the past;
  - the owner's intake acks a provider cursor only after custody (r6 §11.8), and an approved late execution runs once (r6 §11.6).
  
  r6 already says "an uncertain outcome is reported, never retried" (r6 §11.6). It does not say, per op, which errors are refusals and which are delivery failures, or how long a caller may keep retrying a signal before it is too old to act on. Add both to each role document, per op.
- *Cost.* Documentation plus a shared error classification in the SDK.
- *Fit.* Local.

**5. Cap concurrently held calls, and define the budget of a call that joins one already waiting.**
- *Idea.* Parked requests take a slot in a fixed lot, and a request that would park when the lot is full is shed with a named reason. Requests for one actor join a single flight and share its remaining budget. The budget bounds new attempts, never work already committed (`substrate:docs/request-parking.md:46-102`). Each wait records one outcome label (`request-parking.md:156-170`).
- *What it strengthens.* r6 has two kinds of held call: blocking elicitation (r6 §11.5, with joined calls that "never raise a second notification") and compaction WAIT (r6 §5.5, with an "engine-wide cap" on total wait per step, left as deferred item 4 in r6 §18). Neither says how many calls may block at once across sessions, what the refusal is when too many do, or whether a call that joins an existing question gets a fresh deadline or the remainder. Parking's answers are a reasonable default: a named shed when full, the remainder for a joiner, and one outcome label per wait on the observe stream (r6 §12.3).
- *Cost.* Small.
- *Fit.* Local, though less pressing than in a cluster: one user rarely has hundreds of blocked calls. The joined-budget rule matters either way.

**6. Record, step by step, what resume replayed and what it redid.**
- *Idea.* Each workflow step checks whether its postcondition already holds in durable state, and if so marks its trace span `step.skipped` with a reason, "so a re-entered workflow's trace shows which steps fast-forwarded and where real work restarted" (`substrate:cmd/ateapi/internal/controlapi/workflow.go:41-71`).
- *What it strengthens.* r6 §8 and the crash harness in r6 §3.5 assert that nothing recorded is produced again. A per-record marker on resume (replayed from the WAL, re-run because its frame was not durable, re-dispatched under the §8 exception) would make those assertions observable in production as well as in the harness, and would give the observe stream (r6 §12.3) its next event after `compaction_applied`.
- *Cost.* Moderate: an event per replayed step in Broca.
- *Fit.* Local.

**7. State the unknown-field rule for anything that relays or resends.**
- *Idea.* "Modify what you read, do not reconstruct it", and never round-trip through a format that drops unknown fields, so a newer peer's fields survive an older relay (`substrate:docs/api-style-guide.md:500-502`).
- *What it strengthens.* r6 decodes `role.describe` leniently (r6 §3.3) and resends a recorded first send "byte for byte" after an auth pause (r6 §4.5). It does not state the rule for relays in general: AFT's GitHub relay (r6 §4.7.6), the subc-mcp shim (r6 §14.1), Prefrontal's `delegation.sync` built from its store (r6 §4.7.4). A relay that decodes into its own types and re-encodes drops what it does not know. One sentence in r6 §15 and a conformance check (send an unknown field through the relay, require it on the far side) would cover it.
- *Cost.* Small.
- *Fit.* Local.

**8. Declare every field required or optional, and be strict on what you persist.**
- *Idea.* Every API field carries `+k8s:required` or `+k8s:optional`, validation is generated from those tags, and "it is easier to loosen validation than to tighten it" (`substrate:docs/api-validation.md:74-103`). Using an alpha or beta rule requires an explicit acknowledgement (`api-validation.md:85-94`).
- *What it strengthens.* r6's contracts are prose. The manifest (r6 §4.2), the elicitation request (r6 §11.3), `CompactionMessage` (r6 §5.4) and the WAL records under the reader gate (r6 §15) would each benefit from a schema where every field is marked, validated at the boundary before anything is recorded. This fits r6 §9.4's rule that arguments are coerced "before anything records, hashes or checks" them.
- *Contradiction check.* r6 §3.3 decodes `role.describe` leniently. That is not in conflict: be lenient with a peer's self-description and strict with anything written to the WAL or sent to a model.
- *Cost.* Moderate: a schema source shared by Rust and TypeScript in `commons`, and generated validators.
- *Fit.* Local.

**9. Consider requiring the owner's decision before resuming a run with an indeterminate side effect.**
- *Idea.* Substrate seals a failed actor as `CRASHED`, refuses both resume and suspend, and makes the operator choose `RevertActor` (`substrate:docs/upgrade.md:205-220`). A state with unknown effects does not continue on its own.
- *What it would change.* r6 seals a cut run `Interrupted`, and any resend continues it (r6 §5.5). The §8 exception re-dispatches a call whose `ToolDispatchIntent` was not durable, which is safe because nothing was sent. The harder case is an intent that is durable with no result: r6 exposes it as "indeterminate" (r6 §10.2), and elicitation reports `outcome_unknown` (r6 §11.6). r6 does not say whether the next send may proceed as if nothing were wrong.
- *Contradiction.* This leans against r6's "the caller resumes by resending".
  - For: the model will often repeat a call whose outcome it never saw, so an unacknowledged indeterminate `git push` or payment can happen twice through the model rather than through the runner.
  - Against: r6 already puts the indeterminate state in the transcript, the owner (Prefrontal) sees it, and a blocking gate adds friction to the common case where the call was a read.
  
  A middle path is to have the runner insert a fixed, recorded notice ("call X had no recorded result") into the resumed turn, so the model sees the uncertainty, without blocking the resend.
- *Cost.* Small for the notice; more for a gate.
- *Fit.* Local.

**10. Keep secrets out of the agent's reach by injecting them at a proxy.**
- *Idea.* The agent never holds the credential. A gateway it cannot control adds the credential to requests that match a rule, fetches it from a plugin keyed by the agent's verified identity, and overwrites anything the agent set (`substrate:cmd/atenet/internal/router/egress/credentials.go:51-136`, `substrate:pkg/proto/credproviderpb/credprovider.proto:21-47`). Threat T-29 gives the reason: "LLMs are unreliable" (`substrate:docs/threat-model.md:108`).
- *What it would change.* r6 already follows this for delegated speech: the AFT relay never falls back to the operator's account, and bot speech is refused without a stamped agent (r6 §4.7.3, §4.7.6). Plexus holds tokens server-side. The gap is the shell: a local `bash` tool inherits the user's environment, so every exported API key is one `env` away from the model.
- *Contradiction.* r6 says delegation "is not a security boundary" and authority stays with each provider's per-call grant (r6 §4.7).
  - For adopting: a narrowed environment for tool processes (no inherited secrets unless a grant names them) is cheap and protects against a model that prints its environment.
  - Against: on a single-user machine the model's shell can read `~/.config`, keychains and dotfiles directly. Only a sandbox closes that, and a proxy that terminates TLS adds a local CA and moving parts for a small gain. r6's position holds for the full version.
  
  The partial step is AFT's to decide, per provider, as r6 §4.6 allows ("finer limits are each provider's own policy").
- *Cost.* Low for environment scrubbing in AFT; high for a proxy.
- *Fit.* Proxy injection: multi-tenant cloud. Environment scrubbing: local.

**11. Run untrusted work in a sandbox with default-deny egress.**
- *Idea.* gVisor or micro-VM sandboxes, lifecycle controlled from outside, first-match egress rules with default deny (`substrate:docs/threat-model.md:94-99`, `substrate:pkg/proto/ateapipb/ateapi.proto:398-419`).
- *What it would change.* r6's project trust (r6 §4.6) decides whether a repository's configuration may act. It does not contain what the model does in an approved project, and r6 lets AFT run commands in unapproved projects with only the project's filters skipped.
- *Contradiction.* This works against r6 §4.6's "AFT never asks for trust: the command runs".
  - For: an agent working in a freshly cloned, untrusted repository executes that repository's build scripts, and Substrate's T-15 to T-18 are the right list of what can go wrong.
  - Against: a local coding agent needs the user's toolchains, credentials and files. A sandbox that breaks those gets turned off, and r6 correctly makes a narrower toolset Prefrontal's explicit choice at launch rather than a side effect of trust (r6 §4.2).
  
  If CortexKit ever runs agents for other people, or on shared hosts, this becomes the first lesson rather than the last. A local sandboxed runner could exist as an optional `llm-runner` or `tool-provider` implementation without changing r6.
- *Cost.* High.
- *Fit.* Multi-tenant cloud; optional locally.

### 3.1 Where they confirm r6

These need no change, but they are independent evidence for decisions r6 already made.

| r6 decision | Their counterpart |
|---|---|
| Carrier and agent are separate identities, stamped outside the agent's reach (r6 §4.7) | `ateom-for-actor` certificates; "nothing the actor can write contributes to the identity"; plugins see the plain actor (`substrate:cmd/atenet/internal/router/egress/egress.go:133-136`, `credentials.go:79-81`) |
| Identity is fixed when the route opens, not per call (r6 §4.7.2) | Identity from the TLS handshake, checked once per CONNECT rather than per request (`substrate:cmd/atenet/internal/router/egress/egress.go:310-316`) |
| A session keeps its role version for life (r6 §3.4) | Snapshots pin the runtime version that wrote them (`substrate:docs/architecture.md:334`) |
| Pushed sets carry the full state (r6 §3.6) | Worker capacity replaces the record; a missing dimension is no longer supplied (`substrate:pkg/proto/ateapipb/ateapi.proto:2083-2088`) |
| Providers supply, the runner decides (r6 §2 principle 1, §5.5) | "The worker observes; the control plane decides" for suspends (`substrate:cmd/atelet/ateomsupport.go:123-125`) |
| A blocking call that loses its caller becomes pending (r6 §11.5) | `env`'s `shell` shows what happens without such a rule: an orphaned process and no handle (`env:internal/mcp/tools.go:207-268`) |
| Tool-name collisions are refused (r6 §4.5) | `env` refuses duplicate names at registration (`env:internal/tool/tool.go:66-79`) |
| Outputs are deterministic (r6 §4.2) | `env` returns tool definitions sorted (`env:internal/tool/tool.go:91-98`) |
| Refusals are named and typed (r6 §4.7.2, §5.6) | Error mapping by kind for credential fetch and parking; 421 with a stale-assignment marker (`substrate:cmd/atenet/internal/router/egress/credentials.go:33-49`, `substrate:internal/atunnel/ingress.go:554-557`) |

## 4. What r6 does that they do not

- **The model loop itself.** Preflight, frozen prefixes, compaction providers, step-transform hooks, cache breakpoints and change policies (r6 §4–§7, §13) have no counterpart. Substrate is the layer under a harness; `env` is a tool server.
- **At-most-once tool dispatch and exact replay.** r6 writes the intent before a tool runs and replays recorded outputs without calling anyone (r6 §6.3, §8). Substrate restores a snapshot and loses everything after it (§2.4).
- **Transcript reads with lineage.** Tail, range and after-id reads, lineage checks and snapshot handoff (r6 §10) have no counterpart.
- **Asking the user.** Elicitation with dedup, argument binding, three blocking modes and durable `approved → executing → done` (r6 §11) has no counterpart. `env` has no approval of any kind.
- **Discovery and conformance.** `role.describe`, lenient decoding with strict required ops, and per-role suites run against real modules (r6 §3.3–3.5). Substrate skips even the discovery its dependencies offer (lesson 3).
- **Per-agent authorization.** r6 checks the carrier's module grant and the agent's own grant on every call (r6 §4.7.3). Substrate's equivalent is a model with no callers (§2.2).
- **Content authority.** r6 keeps repository content out of system text (r6 §4.3) and makes trust never change the prefix (r6 §4.2). Neither repository deals with prompt-injection paths.

Where they are ahead, and r6 does not try to compete: cryptographic workload identity, kernel-level isolation, whole-process snapshots, network egress policy, and scale.

## 5. Open questions that running code would settle

I ran nothing in the clones. These would settle points this report leaves uncertain:
- Whether `MintAteomActorCertificate` refuses an atelet on a node that does not host the actor, as `substrate:docs/api-guide.md:548-564` says. The code at `ed6d2a1` suggests it does not (§2.2).
- Whether an `env` environment's running process and its process table survive `ate-env suspend` and a resume on the Substrate version `env` pins (§2.3).
- Whether anything outside the repository calls `Control.MintActorJWT`; nothing inside does.
