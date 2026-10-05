# Issue 485 adversarial executing release gate

## Verdict: BLOCK

Reviewed worktree base `6a75c0cd22c03ef15fc3bcd237bc73e347a1d986`, containing merge `60360073` and deliveries `922e8f05` / `4c8ce36a`. Read issue 485 first. No product source was changed. The ordinary reporter sequence passes, including an actual fresh Bun process opening the physical Pi session and persistent SQLite database. Two requested adversarial contracts fail:

1. **J — populated snapshot has no equivalence fence.** A callable manager appends a system delta after Magic Context read the context input, then invokes the real installed Pi `appendCompaction`. The drain accepts its populated snapshot, changing `[read, edit, bash]` to `[edit, bash]` and `BASE_GATE_PROMPT` to `BASE_GATE_PROMPT\n\nRACING_EXTENSION`. A marker is persisted, not refused. The installed resolvers on both the snapshot and served messages confirm this. This violates the maintainer's requested rule: equivalent to the state being folded OR refuse the marker and retain the MC fold. **BLOCK on J.**
2. **E — displaced initial system is still invisible to index-zero lookup.** With `[extension user, initial system, tail user]`, injection leaves a user at index zero. `getCurrentTools` still finds all three tools, but installed `getInitialSystemMessage` returns `undefined`. Preserving system entries somewhere is not sufficient for the initial-only contract. **Second real finding.** This is an adversarial/pre-existing malformed-head compatibility gap, not evidence that MC displaced a valid Pi head by itself.

The committed tests characterize these two failures deliberately: a green characterization suite means the defects were reproduced, **not** that the release gate is SHIP. Neutralizing each adversarial precondition made exactly its named test red (below).

## Executed sequence matrix

All effective tool/prompt checks import the installed `pi-ai-086` resolvers. Physical host operations use installed `pi-coding-agent-086` SessionManager. There is no replacement tool/prompt fold in the tests. Captured served-array SHA-256 values per pass are recorded below; native snapshot timestamps mean some values differ between independent runs, while within-sequence replay must match exactly.

| Sequence | Gate | Executed assertion / result |
| --- | --- | --- |
| A | PASS | N=3 initial tools, M=2 genuinely new tools (not re-additions), initial plus mid-conversation system. Full registered context handler and deferred marker drain. Fold tools exactly `[read, edit, bash, mcp-a, mcp-b]`; prompt exactly `BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT`. Four defer passes, a fresh Bun process loading the physical session and SQLite DB, and LKG replay all have the fold SHA. Child process exit zero and its emitted SHA checked. |
| B | PASS, composition-level reverse order | Ran real injection then real `appendCompaction`, and the reverse order, against the same journal shape. Both messages arrays contain the injected `<session-history>` prefix. Resolved snapshot prompt equals the two original system contents and contains no `<session-history>` bytes. Production order itself is pinned by code layout (injection before drain); the reverse test composes the actual operations, not a reordered full production handler. A exercises the full actual order. |
| C | PASS | After first native marker, appended a post-boundary `toolsAdded: late` system entry, then published a second compartment/marker. Exactly two compaction entries; `late` survives against the new snapshot head, prompt retains POST_BOUNDARY, second fold and following defer bytes match. |
| D | PASS | Before second cut removed `edit` and `mcp-a`; resolved tools exactly `[read, bash, mcp-b, late]` (3+2+1−2), with unchanged effective prompt across that cut. |
| E | FAIL | Extension user before initial system; injected output remains user-headed, current tools=3 but initial resolver undefined. Removing the preceding user in a neutralization mutation makes the initial resolver return the full system object and the characterization test red. Valid native `[systemMessage, summary]` heads are covered by A's four post-marker passes/restart and C's second cut. |
| F | PASS for 0.85-style message shape | Executed six passes (initial execute, four defer, cleared-handler restart) using the full pre-fix Pi source archived from `60360073^1` = `59d2ef9c3b293b491adb39971cfd598439b98022`, and six using current source, in separate processes. Compared every pass record exactly. All SHA values `41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166`; no system entries, installed 0.86 resolvers correctly return tools=[] and prompt="". This is shape parity, not an installed 0.85 binary. Shared plugin dependencies are current, as the fix did not change them. |
| G | PASS | At 95%, eight completed large tool arcs with interleaved system entries; actual cleanup reports reclaimed outputs, both system entries remain byte-equal, served call/result ID sets match. Also executed the installed Anthropic and Responses provider serializers via stream `onPayload`, stopping before network. Both real wire shapes retain exactly two complete tool pairs and all five tools. No provider request was sent. |
| H | PASS | Both clone filter/storage inheritance and physical `SessionManager.createBranchedSession` + `handlePiCloneSessionStart` executed. Full raw messages/ordinals identical in physical fork; copied compartment boundary ordinal=3; untagged source/fork arrays SHA-identical. Tagging fork leaves both system entries unchanged and assigns no tags to their IDs. |
| I | PASS classification; documented capacity hazard | Foreign role=system with no sections/tools is treated identically. A 160,000-byte prompt has zero tag targets and hygiene t/u=0, and Pi's own prompt resolver includes all 160,000 bytes. Exemption matches Pi's role-only semantic boundary; treating such prose as ordinary droppable text would change provider instructions. Hazard is unbounded extension-supplied system mass, not new privilege isolation. Canonical raw ordinals still count system entries; external provider usage is not asserted to ignore it. |
| J | FAIL overall | Missing append method / simulated old readonly runner manager: no marker, pending marker retained, MC history prefix still served, tools/prompt unchanged. Callable throwing signature: same, exception contained, no throw to host. Wholly absent manager: hook returns undefined without throwing (host keeps original input), marker pending, no new fold served on that pass. **Callable populated but divergent snapshot: persisted and adopted, no fence**, as detailed above. |

## Finding scope and refuted premises

**J precision:** the simulated extension wraps the bound runtime method and appends a real system entry at the point of the call. The snapshot is a *correct resolution of the newer journal*, but is *not equivalent to the context Magic Context decided to fold*. The test does not claim Pi's resolver itself is corrupt or that ordinary event-loop interleaving can interrupt synchronous code. A decorated/runtime manager can produce this mismatch; the requested fence is absent. Whether a legitimate concurrent tool removal should instead authorize a new fold is a policy choice for the fix, not something this review silently assumes. The observed outcome is neither equivalence nor refusal.

The delivery report's ordinary preservation/cache claims survived A, C, D, F, G, H. Its broad conclusion that both fold-time loss and head-injection hiding are addressed needs an explicit valid-leading-system precondition (E). Its unavailable-method fail-closed claim survived the missing-method simulation, but does not generalize to a present method producing different populated protocol state (J). The report did not itself claim to have tested that adversarial fence. Its role-only boundary is consistent with actual Pi behavior (I); calling that mass “counted toward nothing” would be too broad: the executed observation is only no mutable targets and zero reclaimable hygiene mass.

## Mutation evidence (no product mutations)

Each test file was staged before mutation, with empty unstaged `git diff --stat`; mutation was marked `NON-VACUITY BREAK`, non-empty stat captured, named test executed, then `git checkout -- <test path> && touch <test path>` restored the staged implementation and empty unstaged stat was captured. No mutant was committed.

| Control | Exact reddened test | Captured failure | Stat during → after |
| --- | --- | --- | --- |
| Remove the extension user that precedes the system head | `E displaced system remains invisible to initial resolver on defer` | `expect(received).toBeUndefined(); Received: { role: "system", content: "BASE_GATE_PROMPT", toolsAdded: [...] }`; 0 pass / 1 fail; 13 others filtered | `issue-485-gate.test.ts: 3 ++-; 2 insertions, 1 deletion` → empty |
| Neutralize the extension's system append inside bound appendCompaction | `J populated stale-view snapshot is adopted without equivalence fence` | `expect(equivalent || markers.length === 0).toBe(false); Expected: false; Received: true`; 0 pass / 1 fail; 13 others filtered | `issue-485-gate.test.ts: 7 +------; 1 insertion, 6 deletions` → empty |

These are finding-neutralization controls, not claims to have disabled product guards. No other selected test failed; other tests were filtered, not claimed as mutation-run passes.

## Verification and limitations

- Worktree frozen install: `bun install --frozen-lockfile` passed; no manifest/lock changes.
- `bun run typecheck` in `packages/pi-plugin`: passed. Since package config excludes tests, also ran `packages/pi-plugin/node_modules/.bin/tsc --noEmit -p packages/pi-plugin/src/issue-485-gate.tsconfig.json` to typecheck the added tests, with Bun types and the project ES2022 library. Passed after correcting test-only cross-version user-message typing and using Pi's branded normalizeContext for wire serialization.
- Pinned local Biome **2.5.1** on the two test files: passed.
- `bun test packages/pi-plugin/src/issue-485-gate.test.ts packages/pi-plugin/src/issue-485-replay-gate.test.ts`: passed, including nested child processes. Two top-level child-only tests are skipped intentionally and executed by parents in subprocesses.
- AFT inspection could not provide a fresh diagnostic result: interrupted, then host-wide route.bind/subc outages. Parent confirmed the outage. tsc is the authoritative gate; no compile claim relies on AFT.
- Comment review completed; clarified the three flagged comments.
- No product build needed: test/report-only change, no packaging/public API modifications.

### Least confident / review first

1. **J simulation provenance:** method wrapper is the explicit adversarial seam. Snapshot matches the changed host journal, not the stale folding input. Review the desired equality authority before implementing the fence; refusing legitimate tool removals forever is not a safe repair.
2. **B reverse-order scope:** only composition order was reversed. Full handler order is not dynamically configurable and remains layout-pinned.
3. **J 0.85 simulation:** readonly manager shape is simulated by hiding appendCompaction, not by booting a real 0.85 ExtensionRunner. A differently callable signature that neither throws nor returns the expected ID was not exhaustively enumerated.
4. **F scope:** pure-replay no-system fixture proves six-pass full-handler parity against the actual pre-fix source, not every possible old-host fixture or native host version.
5. **E scope:** defer/input-head gap; a subsequent trim can promote a formerly displaced system to zero. The test does not establish that every fold preserves the bad position.

## Captured run

The following is the executed test output, including per-pass SHA values and installed-resolver tools/prompt results.

```text
bun test v1.4.2 (744846f84)

packages/pi-plugin/src/issue-485-replay-gate.test.ts:
(skip) F pure replay child
GATE F baseline=59d2ef9c3b293b491adb39971cfd598439b98022 [[{"pass":0,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":1,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":2,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":3,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":4,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":5,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""}],[{"pass":0,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":1,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":2,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":3,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":4,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""},{"pass":5,"sha256":"41a05bbd255f9737780bee967187d339d15ff3b7a902cc6c58a1b1b35d954166","tools":[],"prompt":""}]]
(pass) F no-system served arrays equal pre-fix master on every replay [1000.56ms]

packages/pi-plugin/src/issue-485-gate.test.ts:
(skip) A restart child
GATE {"label":"A-before","sha256":"a2f5b63ce6ed52ca71f108a3fd4e21e1ae450ac4b337798093e10ce3281e2006","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"A-fold","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"A-defer-0","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"A-defer-1","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"A-defer-2","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"A-defer-3","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
bun test v1.4.2 (744846f84)
GATE {"label":"A-process-restart","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}

packages/pi-plugin/src/issue-485-gate.test.ts:
(pass) A restart child [204.18ms]

 1 pass
 14 filtered out
 0 fail
Ran 1 test across 1 file. [545.00ms]

GATE {"label":"A-LKG","sha256":"479eb35a2d6f0101a286c15012615e3c56b5fe7ffafb5cd971138f79faac9488","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"CD-before","sha256":"88be43e80cd4c8b26ee6474cad7b77b305a3d91cbadcc301bc6c95c59382d302","tools":["read","bash","mcp-b","late"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT\n\nPOST_BOUNDARY"}
GATE {"label":"CD-fold","sha256":"a80cedff18ceffe7c379794154983c064e0a2f4c2bfa016487a4ec680c23e9e6","tools":["read","bash","mcp-b","late"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT\n\nPOST_BOUNDARY"}
GATE {"label":"CD-defer","sha256":"a80cedff18ceffe7c379794154983c064e0a2f4c2bfa016487a4ec680c23e9e6","tools":["read","bash","mcp-b","late"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT\n\nPOST_BOUNDARY"}
(pass) A C D reporter fold, process restart, LKG and second cut [1000.74ms]
GATE {"label":"B-inject-first","sha256":"101e0fd42d337e28ec25df27489c528744c551add6bb365c12d3c7a23a165eb6","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
(pass) B snapshot excludes MC prefix inject-first [54.05ms]
GATE {"label":"B-marker-first","sha256":"101e0fd42d337e28ec25df27489c528744c551add6bb365c12d3c7a23a165eb6","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
(pass) B snapshot excludes MC prefix marker-first [53.44ms]
GATE {"label":"E-displaced","sha256":"0224729b82431a9fd7b92e46718f8d250569aed50cab1f75e41cb87bf0aecfd6","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
(pass) E displaced system remains invisible to initial resolver on defer [51.31ms]
GATE I bf3b953cb8a51e11f84ab7caa742246ad952f45f166e0340a7753e7936278d04 promptBytes=160000 tools=0
(pass) I foreign system role is protocol state and excluded mass [39.87ms]
GATE {"label":"H-fork","sha256":"0a94bbc68093b14c42f8178347e061e4119a980efd9645e4236355b9818d4ff8","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
(pass) H clone filter preserves system ordinals without tag targets [42.18ms]
GATE {"label":"G-anthropic-messages-before","sha256":"b752c96e34737095721b6f88a17748370816f14df1260b282c2c5edbaf050f26","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"G-anthropic-messages-after","sha256":"458ced77d7f17a3c3daa0c872a8112547ed18c803dcb49a12d32f8f793debef5","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE G-wire-anthropic-messages sha256=1fcb4aedd6c2afd627de5a1d2ec487ea391d1b57a415992f483132bb03e15819 pairs=2
(pass) G emergency interleaved pairing anthropic-messages [56.19ms]
GATE {"label":"G-openai-responses-before","sha256":"b8b584af0891fb119cb376e42b2fd03f7bb3768e69282396673eb5cee5a52b40","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"G-openai-responses-after","sha256":"be71732afb4dc2518f63cef077d179a463a66aad9329a22a238e03ac7858c84f","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE G-wire-openai-responses sha256=9ccde6d17cd8a4fa9f61149ff29ab6d6559741501bea4e16a124157c3ade0ea1 pairs=2
(pass) G emergency interleaved pairing openai-responses [45.46ms]
GATE {"label":"J-missing-method","sha256":"fae0dec0899c04d55434c233d06387175fac9304e5b069bc6854f82e9962b800","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
(pass) J reflective drain missing-method [66.42ms]
GATE {"label":"J-throwing-signature","sha256":"fae0dec0899c04d55434c233d06387175fac9304e5b069bc6854f82e9962b800","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
(pass) J reflective drain throwing-signature [65.55ms]
GATE {"label":"J-readonly-085","sha256":"fae0dec0899c04d55434c233d06387175fac9304e5b069bc6854f82e9962b800","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
(pass) J reflective drain readonly-085 [64.12ms]
GATE {"label":"J-fence-before","sha256":"5932d4d9da77eba515344382f97aafc1bb26442a902ebaf70243d4335437eeb7","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
GATE {"label":"J-fence-after","sha256":"9d16893f6b88f174c7f530b0c7210cfbc6ed2f8616334040be451b03321a3db4","tools":["edit","bash"],"prompt":"BASE_GATE_PROMPT\n\nRACING_EXTENSION"}
(pass) J populated stale-view snapshot is adopted without equivalence fence [65.62ms]
GATE J-absent result=undefined
GATE {"label":"J-absent-host-input","sha256":"5932d4d9da77eba515344382f97aafc1bb26442a902ebaf70243d4335437eeb7","tools":["read","edit","bash"],"prompt":"BASE_GATE_PROMPT"}
(pass) J wholly absent runtime manager returns unchanged input [56.18ms]
GATE {"label":"H-source","sha256":"a2f5b63ce6ed52ca71f108a3fd4e21e1ae450ac4b337798093e10ce3281e2006","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"H-physical-fork","sha256":"a2f5b63ce6ed52ca71f108a3fd4e21e1ae450ac4b337798093e10ce3281e2006","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
GATE {"label":"H-tagged-fork","sha256":"5fb0f98ec045549c48a5269d32630b679a8ae3fae81aef8666ff9c16a315e039","tools":["read","edit","bash","mcp-a","mcp-b"],"prompt":"BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT"}
(pass) H physical fork inherits protocol entries and compartment ordinals [56.92ms]

 15 pass
 2 skip
 0 fail
 82 expect() calls
Ran 17 tests across 2 files. [3.14s]
```
