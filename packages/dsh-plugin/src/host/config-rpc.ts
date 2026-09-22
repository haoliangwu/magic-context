/**
 * host/config-rpc — user-config read/write for the `magicContext/config` and
 * `magicContext/config-save` Remote endpoints (Phase 6 slice).
 *
 * The browser card needs a structured config editor, so the host exposes the
 * raw user config file. Semantics are ported from the Tauri dashboard's
 * config.rs (`write_config_atomic` + save guard), but kept dependency-free:
 *
 * - read: raw UTF-8 text; a missing file reports `{exists: false}` instead of
 *   an error; a read failure and a JSONC parse failure are surfaced as
 *   distinct diagnostics while still returning whatever content exists.
 * - save: validates the incoming text as JSONC (core's shared parser) AND
 *   against the core config schema before touching the disk, then guards
 *   against clobbering an existing file that cannot be read/parsed, and
 *   finally writes through a same-directory temp file + atomic rename
 *   (`.{name}.{pid}.{stamp}.{n}.tmp`, create-new) so a concurrent reader never
 *   observes a torn file. The content is stored byte-exact: unknown top-level
 *   keys are the editor's concern, not the host's.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { parseJsonc } from "@magic-context/core/shared/jsonc-parser";

/** Raw user config read result (`magicContext/config`). */
export interface UserConfigReadResult {
  readonly path: string;
  readonly exists: boolean;
  /** Raw file text (UTF-8). Empty when the file is missing. */
  readonly content: string;
  /** Set when the file exists but its content is not valid JSONC. */
  readonly parseError?: string;
  /** Set when the file exists but could not be read at all. */
  readonly readError?: string;
}

/** User config save result (`magicContext/config-save`). */
export interface UserConfigSaveResult {
  readonly ok: boolean;
  readonly error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse JSONC for validation only, tolerating a UTF-8 BOM (core loaders do). */
function validateJsonc(text: string): void {
  parseJsonc<unknown>(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

/**
 * Read the raw user config file. `path` is overridable for tests; callers
 * default to the canonical CortexKit user path and MUST NOT pass untrusted
 * paths from the wire.
 */
export function readUserConfig(path: string = resolveCortexKitUserConfigPath()): UserConfigReadResult {
  if (!existsSync(path)) return { path, exists: false, content: "" };
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    // Preserve read failures instead of treating them as an empty file: the
    // editor must not render "empty" state over a config it cannot read.
    return { path, exists: true, content: "", readError: messageOf(error) };
  }
  try {
    validateJsonc(content);
    return { path, exists: true, content };
  } catch (error) {
    return { path, exists: true, content, parseError: messageOf(error) };
  }
}

/**
 * Validate + atomically save the raw user config file. Hard-refuses: content
 * that is not valid JSONC, content that does not validate against the core
 * config schema, and any write that would clobber an existing unreadable or
 * unparseable file. Stored byte-exact (raw text, no reformatting).
 */
export function saveUserConfig(
  content: string,
  path: string = resolveCortexKitUserConfigPath(),
): UserConfigSaveResult {
  if (typeof content !== "string") {
    return { ok: false, error: "config content must be a string" };
  }

  // Gate 1: well-formed JSONC. parseJsonc strips comments/trailing commas and
  // JSON.parses; it throws with the underlying parser message on failure.
  let document: unknown;
  try {
    document = parseJsonc<unknown>(content.startsWith("\uFEFF") ? content.slice(1) : content);
  } catch (error) {
    return { ok: false, error: `config is not valid JSONC: ${messageOf(error)}` };
  }

  // Gate 2: a config file must be a JSON object, not an array or scalar.
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, error: "config must be a JSON object at the top level" };
  }

  // Gate 3: core config schema. Unknown top-level keys are stripped by the
  // schema (runtime does the same), so the gate only refuses values the
  // runtime itself would reject or recover-with-defaults.
  const parsed = MagicContextConfigSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join(".")}"` : "";
    return {
      ok: false,
      error: `config does not validate: ${first?.message ?? "invalid config"}${where}`,
    };
  }

  // Save guard: never destroy an existing file we cannot read or parse.
  if (existsSync(path)) {
    let current: string;
    try {
      current = readFileSync(path, "utf-8");
    } catch (error) {
      return {
        ok: false,
        error: `existing config at ${path} could not be read (${messageOf(error)}); refusing to overwrite`,
      };
    }
    try {
      validateJsonc(current);
    } catch (error) {
      return {
        ok: false,
        error: `existing config at ${path} is not valid JSONC (${messageOf(error)}); refusing to overwrite an unparseable file — fix it manually first`,
      };
    }
  }

  // Atomic write: same-directory temp file (create-new) + rename, matching the
  // Tauri dashboard's `.{name}.{pid}.{stamp}.{n}.tmp` pattern.
  mkdirSync(dirname(path), { recursive: true });
  const stem = basename(path);
  for (let attempt = 0; attempt < 16; attempt++) {
    const temporaryPath = join(
      dirname(path),
      `.${stem}.${process.pid}.${Date.now()}.${attempt}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, content);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      return { ok: true };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The write error below remains the actionable error.
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort temp cleanup; the original error is what matters.
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { ok: false, error: `failed to write config: ${messageOf(error)}` };
    }
  }
  return { ok: false, error: `could not allocate a temporary config file beside ${path}` };
}