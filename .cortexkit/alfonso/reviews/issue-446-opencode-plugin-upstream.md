# `@opencode/plugin`: accept Bun `ResolveMessage` by code

`Host.resolve()` in `@opencode/plugin@2.0.3` rethrows an expected optional-entry miss on Bun 1.3.x. `Bun.resolveSync()` throws a `ResolveMessage` with `code: "ERR_MODULE_NOT_FOUND"`, but that object is not `instanceof Error`, so the current guard rejects it before consulting the existing code allowlist.

Please duck-type the caught value before checking `code`, for example:

```ts
const candidate = error as { code?: unknown } | null;
if (
  typeof candidate !== "object" ||
  candidate === null ||
  !("code" in candidate) ||
  !missingEntryCodes.includes(String(candidate.code))
) {
  throw error;
}
```

The existing allowlist already contains the right code; only the `instanceof Error` requirement needs to change. This also keeps the resolver tolerant of equivalent cross-realm and future runtime error objects.
