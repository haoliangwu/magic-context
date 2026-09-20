# OpenCode 2 runner

Run `bun install`, initialize the pinned CLI if Bun blocked its postinstall (`cd packages/plugin/node_modules/@opencode/cli && node postinstall.mjs`), and run `bun run --cwd packages/plugin build:v2`. Then:

```sh
bun test packages/e2e-tests/tests/opencode2
packages/plugin/node_modules/.bin/tsc -p packages/e2e-tests/src/opencode2-runner/tsconfig.json
```

The runner never uses the operator's config or provider credentials. The mock binds explicitly to 127.0.0.1. Every server has a fresh HOME and all four XDG roots, an allowlisted environment, a detached process group, and bounded event-driven startup. `lsof` and `ps` are required, not optional. At handoff and teardown the whole process group is checked for forbidden open paths, and lsof's inode must match the expected private database. These are samples, not continuous kernel-level monitoring. Exit/signal handlers reap live v2 groups. Teardown kills the entire group even if safety inspection fails.

The live database edge hashes/mtime and log snapshots run only when `pgrep -f 'opencode serve'` finds no active v1 host. Otherwise the runner prints the named snapshot skip reason; the environment, descriptor and placement checks still run. This owner-approved correction avoids blaming unrelated v1 writes on the v2 child.

## Observed GA corrections

* `serve --standalone` really exits 1 with `Unrecognized flag: --standalone in command opencode serve`. Help alone was insufficient: `--help` bypasses argument rejection. The named constant is `--standalone`, but the runner uses direct `serve --hostname 127.0.0.1 --port 0`, without `--service`. The standalone rejection has its own real-CLI test.
* `OPENCODE_DB=opencode2.db` **is honoured by the installed CLI 2.0.5**, despite the earlier core-only grep. The actual files are `$XDG_DATA_HOME/opencode/opencode2.db`, `-wal`, and `-shm`; lsof verifies the DB inode. The read site was not located in the native CLI binary. Private XDG roots remain the primary isolation boundary.
* V2 config uses `plugins`, `providers`, and provider `settings`, not v1's singular keys/options. The source for these shapes is installed `@opencode/schema@2.0.5 dist/config/{plugin,provider,model}.js`; the attached core `mime-0gc96ev3.js:119-121` also lists the plural keys. A 16k mock catalog requires a smaller explicit compaction buffer/keep budget to avoid compacting immediately with the host's large default reserve.
* Directory plugin targets resolve `<directory>/server` before `<directory>/index`, bypassing package exports. The published root `server.js` shim and the `./server` export both reach `dist/v2/server.js`. The root v1 export and TUI export are unchanged. Both target forms are tested against the real GA `Host.resolve`.

## Evidence and artifacts

`evidence-sha256.json` pins the supplied audit/playbook/GA bytes under `.cortexkit/alfonso/drafts/oc2-evidence/`. Main citations:

* `ga/core-module-schema.excerpt.js:34-67`: id/setup schema, extra-key tolerance and schema errors wrapped by the host as `PluginModule.LoadError`.
* `ga/plugin-host.js:4-29`: directory/name resolution and optional RPC absence.
* `ga/plugin-promise-session.d.ts:105-107`: session create/prompt domain. The installed SDK `@opencode/client@2.0.5 dist/promise/client.d.ts:22-54` exposes agent list/get only and session create/prompt; the plugin `dist/promise/agent.d.ts:5-14` has no add/register operation. Use session.create with an explicit model, then prompt for hidden children. Prompt itself does not accept a model override.
* `ga/core-session-sql.excerpt.js` and `oc-audit-7a31b5c0f7.md:166-202`: JSON row storage, seq ordering and source filename rule. Sanitization follows the owner's R16 removal rule, rather than the audit's older replacement-with-hyphen spelling.
* `opencode-core-2.0.3/package/dist/chunks/mime-vz9r8jjr.js:45-54`: completed checkpoint selection and inclusive seq cut for the latest boundary. The reader is a raw row reader; it does not emulate the host's provider-specific checkpoint replay filters.
* `aft-playbook-fe8d4871f.md:54-64`: serve handoff and explicit mock provider routing.

`host-rows.json` is a small, unmodified row capture from real GA writes, not a fabricated host-store oracle. The reader tests reconstruct just the session_message table from those rows and separately label synthetic checkpoint edge cases. Record it explicitly with `OC2_RECORD_FIXTURE=1`; normal tests never update goldens. `sha256-pins.json` also pins the v1 codec golden, existing e2e mutation golden set, and root plugin source against base commit `21d161b62cd58b3053bc84028a39d10c786bf314`.

The payload probe uses scratch plugins, separate from the published entry, to submit equivalent text/thinking/tool-use/tool-result drafts through the actual two hosts. The native hook data shapes differ, so each scratch adapter constructs its host's representation. The existing mock captures parsed provider bodies (the same capture boundary used by the v1 lane); `payload-v1.json` and `payload-v2.json` retain those bodies, including host-owned tools/options. `probe-results.json` records the divergent verdict and differing top-level fields. Full body identity is not claimed: the host tools and default options differ as well as serialization. The probe does not change any existing Rust profile; the owner decides the gated profile slice.

## Acceptance map

| Item | Test |
| --- | --- |
| I0 / I12 safety | `hermetic_v2_runner environment refuses unsafe roots before boot`; `fd guard refuses operator paths and permits isolated database`; `live snapshot detects changed database and logs`; `handoff requires ordered URL and password` |
| I0a | `payload_identity_probe records real v1 and v2 provider bodies` |
| I0b | Real explicit-model create/prompt in both v2 lane tests; SDK surface recorded in probe-results |
| I0c | `rpc_entry_absence_probe and named/directory targets share server identity` |
| I1 | `GA Module accepts exact id/setup export`; `GA Module ignores extras and rejects v1 id/server with LoadError cause`; `v2_loads_via_exports_map and session_message_reader real host writes` |
| I2 | `v1_untouched and captured fixture bytes remain sha256 pinned`; real v1 payload lane |
| Reader | `R16 source filename table covers every channel and override branch`; `session_message_reader seq pages idle boundaries and checkpoint window` |

## Type boundary caution for later hook work

The empty production entry deliberately does not import the GA Plugin type namespace. Importing it into the v1 package-wide TypeScript program introduces Effect rc.112's global readonly `Error[ignore]` augmentation and breaks the unchanged v1 command sentinel assignment (`command-handler.ts:221`, TS2540). Removing that unnecessary import restored the full package typecheck and build; the entry is validated against the GA schema and the real loader instead. Later hook slices need to account for this cross-generation ambient-type collision rather than changing the v1 sentinel without owner review.
