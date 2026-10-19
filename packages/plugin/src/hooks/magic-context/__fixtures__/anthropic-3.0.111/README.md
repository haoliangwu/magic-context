# Anthropic 3.0.111 conversion fixture

Verbatim files from the npm tarball
<https://registry.npmjs.org/@ai-sdk/anthropic/-/anthropic-3.0.111.tgz>.
Tarball SHA-256: `73bea91ccdc47af4efa1b6d77b8a4fe4af6303d16abc04aba54b2b1f75f6086e`.

Only `src/convert-to-anthropic-messages-prompt.ts` and its local import closure
are copied, with the upstream `LICENSE`. The source files have no license header;
the license is retained unchanged. Source paths below omit the tarball's `src/`
prefix and append `.txt` so these files remain test data, not production modules.
`motor-double-bust.test.ts` verifies every file hash, bundles this source in memory
for the conversion, and cross-checks its messages against the installed 3.0.82 SDK.
External imports use the repository's locked provider utilities and Zod.

| File | SHA-256 |
| --- | --- |
| `convert-to-anthropic-messages-prompt.ts.txt` | `5e975773398571c61d5b13bd99efddcf5e2662f9c0fe3549a5a951637936d04b` |
| `anthropic-messages-api.ts.txt` | `50033c72eacb6e8deb70c01d64c61990aeaf63e7eecd0ebf355b14bde51a1846` |
| `anthropic-messages-options.ts.txt` | `d9dafb5714115c01e0b3bf1c88d2e2a9be441a40b94423f0dcdf889915d61b6b` |
| `get-cache-control.ts.txt` | `82ef31af4f69e43dbd407d7f6e3fd48f374c17310d7a17823f0918b1cf6bf5ab` |
| `tool/advisor_20260301.ts.txt` | `3100075c29ce970849887638d409729b465735cb87915fb473460ae68bd8564e` |
| `tool/code-execution_20250522.ts.txt` | `cdf59e171f633d48165edca287843add868768cf7e44045e0ef29e6654fcdda3` |
| `tool/code-execution_20250825.ts.txt` | `eb048a8918ecc2e51970d0f6c102e2c75e85b2737449bf029e74f6a07e9aa548` |
| `tool/code-execution_20260120.ts.txt` | `4a4b4abeb976db8673627a602d050cc6fb3dcd5b021de9548381c7e82bdb38a5` |
| `tool/tool-search-regex_20251119.ts.txt` | `634cdc1e5f28f0c30779500e8c403e6ea6ebe51de314c207b4fce7553d470573` |
| `tool/web-fetch-20250910.ts.txt` | `5aba8c2fb0e21c4a9b3eca3fcf71804bf9060741342aedce01a39436f5295273` |
| `tool/web-search_20250305.ts.txt` | `7b4cb9d54cea9c97bf61283006b180ba0a579619f9b394ae5461ae90f6249887` |
| `LICENSE` | `b4f9adb7c568904834d0dd6cc98d16c390d21ca32fc17ae7a267715269bd5529` |
