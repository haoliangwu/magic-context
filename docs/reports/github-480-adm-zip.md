# Issue 480: published-package `adm-zip` audit remediation

## Consumer reproduction before the change

Both checks used a new temporary directory with only the published `0.42.6` tarball as a dependency, followed by:

```bash
npm install --package-lock-only --legacy-peer-deps
npm audit
```

### `@cortexkit/pi-magic-context@0.42.6`

```text
# npm audit report

adm-zip  <=0.6.0
Severity: high
adm-zip: Crafted ZIP file triggers 4GB memory allocation - https://github.com/advisories/GHSA-xcpc-8h2w-3j85
adm-zip extraction follows destination symlinks, allowing arbitrary file overwrite - https://github.com/advisories/GHSA-vwc7-r8mq-g2x9
adm-zip: Uncontrolled memory allocation via the declared uncompressed size (DoS) - https://github.com/advisories/GHSA-7q85-xj36-vmfc
fix available via `npm audit fix --force`
Will install @cortexkit/pi-magic-context@0.41.0, which is a breaking change
node_modules/adm-zip
  onnxruntime-node  1.22.0-dev.20250415-c18e06d5e3 - 1.29.0-dev.20260811-e415ef9afd
  Depends on vulnerable versions of adm-zip
  node_modules/onnxruntime-node
    @cortexkit/pi-magic-context  >=0.41.1
    Depends on vulnerable versions of onnxruntime-node
    node_modules/@cortexkit/pi-magic-context

3 high severity vulnerabilities

To address all issues (including breaking changes), run:
  npm audit fix --force
```

### `@cortexkit/opencode-magic-context@0.42.6`

The registry also reported unrelated low-severity Babel findings in this package's graph. The `adm-zip` portion and final totals were:

```text
# npm audit report

@babel/core  <=7.29.0
@babel/core: Arbitrary File Read via sourceMappingURL Comment - https://github.com/advisories/GHSA-4x5r-pxfx-6jf8
fix available via `npm audit fix --force`
Will install @cortexkit/opencode-magic-context@0.27.1, which is a breaking change
node_modules/@babel/core
  @opentui/solid  <=0.0.0-20260830-b89918f6 || >=0.1.11
  Depends on vulnerable versions of @babel/core
  node_modules/@opentui/solid
    @cortexkit/opencode-magic-context  >=0.17.1
    Depends on vulnerable versions of @opencode-ai/plugin
    Depends on vulnerable versions of @opentui/solid
    Depends on vulnerable versions of onnxruntime-node
    node_modules/@cortexkit/opencode-magic-context
    @opencode-ai/plugin  <=0.0.0-tui-v2-202606261840 || >=1.3.4
    Depends on vulnerable versions of @opentui/solid
    node_modules/@opencode-ai/plugin

adm-zip  <=0.6.0
Severity: high
adm-zip: Crafted ZIP file triggers 4GB memory allocation - https://github.com/advisories/GHSA-xcpc-8h2w-3j85
adm-zip extraction follows destination symlinks, allowing arbitrary file overwrite - https://github.com/advisories/GHSA-vwc7-r8mq-g2x9
adm-zip: Uncontrolled memory allocation via the declared uncompressed size (DoS) - https://github.com/advisories/GHSA-7q85-xj36-vmfc
fix available via `npm audit fix --force`
Will install @cortexkit/opencode-magic-context@0.27.1, which is a breaking change
node_modules/adm-zip
  onnxruntime-node  1.22.0-dev.20250415-c18e06d5e3 - 1.29.0-dev.20260811-e415ef9afd
  Depends on vulnerable versions of adm-zip
  node_modules/onnxruntime-node

6 vulnerabilities (3 low, 3 high)

To address all issues (including breaking changes), run:
  npm audit fix --force
```

This confirms that a repository-root override cannot protect either consumer graph.

## Dependency and package changes

Registry metadata was rechecked before the update:

- `@huggingface/transformers@4.3.0` declares `onnxruntime-node: 1.30.0`, `onnxruntime-web: 1.31.0-dev.20260914-8d85527a0`, and `sharp: ^0.35.4`.
- `onnxruntime-node@1.30.0` declares `adm-zip: ^0.6.0`.
- The resolved repository tree selects `adm-zip@0.6.1`; its `AdmZip` instances still expose both `getEntry` and `extractEntryTo` as functions.
- Both published plugins now bundle Transformers 4.3.0 and declare optional `onnxruntime-node@1.30.0`. The CLI does not declare either dependency.
- The root override is now `adm-zip: ^0.6.1`.

`bun run build:dists` regenerated both plugins' ignored `dist/transformers-*.js` artifacts and ended with `dists LOAD OK`. The rebuilt artifacts identify Transformers 4.3.0.

## Packed consumer audit gate

`scripts/audit-packed-packages.ts` runs `npm pack` for each published plugin, installs that exact tarball into its own temporary npm project with `npm install --package-lock-only --legacy-peer-deps`, and parses `npm audit --json`. A release stops if either packed consumer graph has a high or critical finding. `scripts/release.sh` runs the gate after both plugin builds.

Final result:

```text
[packed-audit] @cortexkit/opencode-magic-context: low=4 moderate=0 high=0 critical=0
[packed-audit] @cortexkit/pi-magic-context: low=0 moderate=0 high=0 critical=0
[packed-audit] PASS: packed consumer graphs contain no high/critical findings
```

As a non-vacuity check, changing only the packed Pi manifest back to `onnxruntime-node@1.24.3` made the gate report `high=3` and fail on `@cortexkit/pi-magic-context`, `adm-zip`, and `onnxruntime-node`.

## Local embedding revalidation

The fixed sentence was:

```text
Magic Context keeps durable project memories across coding sessions.
```

Both versions used the same cached `Xenova/all-MiniLM-L6-v2/onnx/model.onnx` file (90,387,606 bytes, SHA-256 `759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e`). The model artifact did not change.

| Host/runtime | Transformers 4.2.0 vector SHA-256 | Transformers 4.3.0 vector SHA-256 | Result |
| --- | --- | --- | --- |
| Bun 1.4.2 native ORT | `330d2ce5854d649b94b246b37ca52bc22f647952fcab1c9e3c56647b3ff0ffe5` | `9fe7db32a9b12b308dcca98ce67e3a8289415c75f656c38bb835e21b36a59a92` | fp32 `Float32Array`, 384 dimensions; not byte-stable |
| Bun 1.4.2 forced WASM | `8e8323aff6c8d162ec4b3fd158a36616e1e105143678af97536ce2c5c74a2d22` | `8e8323aff6c8d162ec4b3fd158a36616e1e105143678af97536ce2c5c74a2d22` | fp32 `Float32Array`, 384 dimensions; byte-stable |
| Node native ORT (Pi host path) | — | `9fe7db32a9b12b308dcca98ce67e3a8289415c75f656c38bb835e21b36a59a92` | fp32 `Float32Array`, 384 dimensions; matches Bun native |

Because the native vector changed while the model file did not, the local provider identity now includes the Transformers, native ORT, and web ORT runtime versions. Memory identities change directly, and chunk identities already derive from the provider identity, so old and new vector spaces cannot be silently mixed.

The existing local embedding tests passed, including Bun 1.4 native selection, native-to-WASM fallback, fp32 pipeline options, and the `onnxruntime-web` `numThreads = 1` idle-spin guard. The CLI doctor runtime tests passed, and its Pi resolution probe loaded the resolved `onnxruntime-node@1.30.0` Darwin arm64 binding successfully from a throwaway/worktree path.

## Issue reply draft

Thanks for the precise report. We moved the remediation into the dependency graph that consumers actually install: both published plugins now bundle `@huggingface/transformers@4.3.0` and declare optional `onnxruntime-node@1.30.0`, whose `adm-zip` range resolves to `0.6.1`. The repository override is also `^0.6.1`.

We added a release gate that packs each plugin, installs the packed tarball into a clean temporary npm project, and requires `npm audit --json` to report zero high and critical findings. That gate is green for both package tarballs and would have rejected the old `onnxruntime-node@1.24.3` graph.

We also revalidated local fp32 embeddings through Bun native ORT, the single-threaded WASM fallback, and the Node/Pi path. The native runtime upgrade changes vector bytes even though the model artifact is unchanged, so the local embedding identity now includes the runtime stack version and triggers a clean re-embed instead of mixing vector spaces.

For anyone who must stay on an older Magic Context release, the consumer-root workaround remains:

```jsonc
// ~/.pi/agent/npm/package.json — or the installing project's root package.json
"overrides": { "adm-zip": "^0.6.1" }
```

```bash
npm install --legacy-peer-deps
```

This ships in the next release.
