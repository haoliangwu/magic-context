/*!
 * dsh-magic-context — editable user-config form (browser half).
 *
 * Plain-React port of the Tauri dashboard's ConfigEditor (SolidJS) reduced to
 * what a user-level settings pane needs: the form + raw-JSONC tabs, the field
 * definitions, the scalar-or-{default, model: value} threshold widgets, the
 * per-harness hidden-agent model blocks, and the deep-merge save path.
 *
 * Deliberately dropped from the dashboard version (documented deviations):
 *   - Project-config tab and the project-scope pruning rules — this pane edits
 *     only ~/.config/cortexkit/magic-context.jsonc.
 *   - Test Connection (a Tauri command) and the DB stats bar.
 *   - Model pickers backed by a live model catalog: the dsh client has no
 *     catalog, so every model field is a text input holding the stored id.
 *     dsh resolves Magic Context agent models from dsh agent options anyway.
 *   - Per-task per-harness dreamer model overrides (dreamer.<harness>.tasks);
 *     the harness-independent schedules (dreamer.tasks) are editable.
 *
 * Reactivity: the dashboard's createSignal/createMemo/Show/For are rewritten as
 * useState/useMemo + plain conditionals. No Solid idioms survive.
 *
 * Security: every dynamic value renders as React text content. This module must
 * never touch innerHTML/insertAdjacentHTML — a static audit of the built bundle
 * (src/host/remote-security.test.ts) fails the build otherwise.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

/* ------------------------------------------------------------ wire shapes */

/** `magicContext/config` payload (mirror of host/config-rpc.ts; never imported from host). */
export interface UserConfigRead {
  readonly path: string;
  readonly exists: boolean;
  /** Raw file text (UTF-8); empty when the file is missing. */
  readonly content: string;
  /** Set when the file exists but is not valid JSONC. */
  readonly parseError?: string;
  /** Set when the file exists but could not be read. */
  readonly readError?: string;
}

/** `magicContext/config-save` payload. */
export interface UserConfigSaveOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** Snapshot held by the settings-section controller. */
export interface ConfigSnapshotState {
  readonly state: "idle" | "loading" | "ready" | "error";
  readonly config: UserConfigRead | null;
  readonly error: { readonly code: string; readonly message: string; readonly details: unknown } | null;
}

/** Content written by the "create with defaults" affordance. */
export const MAGIC_CONTEXT_SCHEMA_URL =
  "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";

export const USER_DEFAULT_CONFIG = `{
  "$schema": "${MAGIC_CONTEXT_SCHEMA_URL}",
  "enabled": true
}`;

/* ------------------------------------------------------------ JSONC parsing */

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Copy parsed JSON into fresh own-property-only containers, dropping keys that
 * could mutate an object prototype during a later merge. Mirrors the runtime
 * loader's sanitizer so the form never carries a polluted tree into a save.
 */
function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value === null || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue;
    sanitized[key] = sanitizeJson(entry);
  }
  return sanitized;
}

/** Strip // and /* *​/ comments (string-aware). Same grammar as the host parser. */
function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function stripTrailingCommas(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < content.length && /\s/.test(content[lookahead] ?? "")) lookahead += 1;
      const next = content[lookahead];
      if (next === "}" || next === "]") continue;
    }
    result += char;
  }
  return result;
}

interface ParsedConfigContent {
  readonly value: Record<string, unknown>;
  readonly error: string | null;
}

/** Parse JSONC into an object; an unparseable document returns an error and an empty object. */
function parseConfigContent(text: string): ParsedConfigContent {
  if (text.trim() === "") return { value: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (error) {
    return { value: {}, error: error instanceof Error ? error.message : String(error) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: {}, error: "配置文件的根必须是一个 JSON 对象" };
  }
  return { value: sanitizeJson(parsed) as Record<string, unknown>, error: null };
}

/** Pretty-print a config object as JSON (2-space). Comments are lost — same tradeoff as the dashboard. */
function toJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/* ------------------------------------------------------------ object helpers */

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = cloneJson(entry);
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getNested(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setNested(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = cloneJson(source) as Record<string, unknown>;
  const parts = path.split(".");
  let current = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!isRecord(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

/** Shallow copy without undefined values (undefined = "drop this key"). */
function pruneUndefined(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------ field metadata */

interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly type: "boolean" | "number" | "string" | "select";
  readonly options?: readonly string[];
  readonly description: string;
  readonly section: string;
  /** Runtime default, shown when the key is absent. Booleans fall back to true when unset. */
  readonly defaultValue?: boolean | number | string;
}

/** Field list ported from the dashboard's FIELD_DEFS (user-scope subset). */
const FIELD_DEFS: readonly FieldDef[] = [
  {
    key: "enabled",
    label: "Enabled",
    type: "boolean",
    description: "Enable the magic-context plugin",
    section: "General",
    defaultValue: true,
  },
  {
    key: "allow_home_project",
    label: "Allow Home Directory Sessions",
    type: "boolean",
    description:
      "Allow sessions started exactly from your home directory to use a durable Magic Context project identity. User-level only.",
    section: "General",
    defaultValue: false,
  },
  {
    key: "language",
    label: "Output Language",
    type: "string",
    description:
      "Optional user-level output language for Magic Context generated prose and guidance, as a 2-letter ISO 639-1 code (e.g. tr, es, de, ja). Leave blank to keep today's behavior.",
    section: "General",
  },
  {
    key: "toast_duration_ms",
    label: "Toast Duration (ms)",
    type: "number",
    description: "How long Magic Context TUI toasts stay visible.",
    section: "General",
  },
  {
    key: "mural.enabled",
    label: "Mural Enabled",
    type: "boolean",
    description: "Render a deterministic image of project memories that did not fit the context budget.",
    section: "Mural",
    defaultValue: false,
  },
  {
    key: "mural.model",
    label: "Cue Compressor Model",
    type: "string",
    description:
      "Model used to compress each memory into a mural cue. The mural image itself is rendered deterministically.",
    section: "Mural",
  },
  {
    key: "protected_tokens",
    label: "Protected tokens",
    type: "number",
    description:
      "Absolute token floor protected from automatic reclaim (4,000–1,000,000). Leave blank to derive it from the model's usable context window. User-level only.",
    section: "Tags & Cleanup",
  },
  {
    key: "clear_reasoning_age",
    label: "Clear Reasoning Age",
    type: "number",
    description: "Tag age after which reasoning blocks are cleared.",
    section: "Tags & Cleanup",
  },
  {
    key: "history_budget_percentage",
    label: "History Budget %",
    type: "number",
    description: "Fraction of context limit reserved for rendered history (0.0–1.0).",
    section: "Historian",
  },
  {
    key: "historian_timeout_ms",
    label: "Historian Timeout (ms)",
    type: "number",
    description: "Max wait time for a historian run before timeout.",
    section: "Historian",
  },
  {
    key: "memory.enabled",
    label: "Memory Enabled",
    type: "boolean",
    description: "Enable cross-session project memory.",
    section: "Memory",
    defaultValue: true,
  },
  {
    key: "memory.injection_budget_tokens",
    label: "Injection Budget (tokens)",
    type: "number",
    description: "Max tokens for memory injection into session history.",
    section: "Memory",
  },
  {
    key: "memory.auto_promote",
    label: "Auto Promote",
    type: "boolean",
    description: "Automatically promote session facts to project memory.",
    section: "Memory",
    defaultValue: true,
  },
  {
    key: "memory.retrieval_count_promotion_threshold",
    label: "Retrieval Count Promotion Threshold",
    type: "number",
    description: "Minimum ctx_search retrieval count before a session fact is auto-promoted to project memory.",
    section: "Memory",
  },
];

/** Number fields rendered as a range slider instead of a text box. */
const RANGE_SLIDER_FIELDS = new Set([
  "history_budget_percentage",
  "clear_reasoning_age",
  "historian_timeout_ms",
  "memory.injection_budget_tokens",
]);

interface RangeConfig {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix: string;
  readonly defaultValue: number;
}

function rangeConfigFor(key: string): RangeConfig {
  switch (key) {
    case "history_budget_percentage":
      return { min: 0.05, max: 0.5, step: 0.01, suffix: "", defaultValue: 0.15 };
    case "clear_reasoning_age":
      return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 50 };
    case "historian_timeout_ms":
      return { min: 60000, max: 600000, step: 30000, suffix: " ms", defaultValue: 300000 };
    case "memory.injection_budget_tokens":
      return { min: 500, max: 20000, step: 500, suffix: " tokens", defaultValue: 4000 };
    default:
      return { min: 0, max: 100, step: 1, suffix: "", defaultValue: 0 };
  }
}

/* ------------------------------------------------------------ harness metadata */

export type Harness = "opencode" | "pi" | "omp";

/** Per-harness model blocks the form renders (opencode / pi / omp, in order). */
export const HARNESSES: readonly { readonly id: Harness; readonly label: string }[] = [
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
  { id: "omp", label: "OMP" },
];

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OMP_THINKING_LEVELS = [...PI_THINKING_LEVELS, "inherit", "auto"] as const;

function thinkingLevelsFor(harness: Harness): readonly string[] {
  return harness === "omp" ? OMP_THINKING_LEVELS : PI_THINKING_LEVELS;
}

function qualifierKeyFor(harness: Harness): "variant" | "thinking_level" {
  return harness === "opencode" ? "variant" : "thinking_level";
}

function qualifierLabelFor(harness: Harness): string {
  return harness === "opencode" ? "variant" : "thinking level";
}

function modelIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const candidate = record(value).model;
  return typeof candidate === "string" ? candidate : undefined;
}

function modelQualifierOf(value: unknown, harness: Harness): string | undefined {
  const candidate = record(value)[qualifierKeyFor(harness)];
  return typeof candidate === "string" ? candidate : undefined;
}

type ModelEntry = string | Record<string, unknown>;

function entryWithModel(value: unknown, harness: Harness, model: string | undefined): ModelEntry | undefined {
  if (model === undefined || model === "") return undefined;
  const qualifier = modelQualifierOf(value, harness);
  return entryWithQualifier(model, harness, qualifier);
}

/**
 * Rebuild one model entry. A qualifier with no model is meaningless (the
 * schema needs `model`), so it yields undefined — the caller's undefined patch
 * drops the key, matching the dashboard's modelEntryWithQualifier.
 */
function entryWithQualifier(model: string | undefined, harness: Harness, qualifier: string | undefined): ModelEntry | undefined {
  if (model === undefined || model === "") return undefined;
  if (qualifier === undefined || qualifier === "") return model;
  return harness === "opencode" ? { model, variant: qualifier } : { model, thinking_level: qualifier };
}

function fallbackEntries(value: unknown): ModelEntry[] {
  return Array.isArray(value) ? value.filter((entry): entry is ModelEntry => modelIdOf(entry) !== undefined) : [];
}

/* ------------------------------------------------------------ dreamer tasks */

interface DreamTaskMeta {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly defaultSchedule: string;
}

/** Mirrors the plugin schema's canonical dream tasks + default schedules. */
const DREAM_TASKS: readonly DreamTaskMeta[] = [
  { name: "map-memories", label: "Map memories", description: "Maps each memory to its backing files so verify knows what to re-check", defaultSchedule: "0 2 * * *" },
  { name: "verify", label: "Verify changed memories", description: "Checks changed-file memories against code and fixes/removes stale ones", defaultSchedule: "0 3 * * *" },
  { name: "verify-broad", label: "Verify all memories", description: "Periodic full re-check of the whole memory pool (catches drift)", defaultSchedule: "0 4 * * 0" },
  { name: "curate", label: "Curate memories", description: "Deduplicates, tightens, and prunes the memory pool", defaultSchedule: "0 4 * * 0" },
  { name: "compress-cues", label: "Compress mural cues", description: "Compresses each overflow memory into a mural cue", defaultSchedule: "0 4 * * *" },
  { name: "classify-memories", label: "Classify memories", description: "Scores memory importance, scope, and shareability", defaultSchedule: "0 6 * * *" },
  { name: "retrospective", label: "Retrospective", description: "Learns from moments you had to correct or re-explain, and records the lesson", defaultSchedule: "0 5 * * *" },
  { name: "maintain-docs", label: "Maintain docs", description: "Keep ARCHITECTURE.md / STRUCTURE.md in sync", defaultSchedule: "" },
  { name: "evaluate-smart-notes", label: "Evaluate smart notes", description: "Surface smart notes whose conditions are now met", defaultSchedule: "0 3 * * *" },
  { name: "review-user-memories", label: "Review user memories", description: "Promote recurring behaviors into your user profile", defaultSchedule: "0 3 * * *" },
  { name: "promote-primers", label: "Promote primers", description: "Promote recurring project questions into Primers", defaultSchedule: "0 3 * * *" },
  { name: "refresh-primers", label: "Refresh primers", description: "Refresh answers for active project Primers", defaultSchedule: "0 3 * * *" },
];

const SCHEDULE_PRESETS: readonly { readonly label: string; readonly cron: string }[] = [
  { label: "Nightly (3am)", cron: "0 3 * * *" },
  { label: "Weekly (Sun 4am)", cron: "0 4 * * 0" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Disabled", cron: "" },
];

const CUSTOM_SCHEDULE = "__custom__";

function isPresetSchedule(cron: string): boolean {
  return SCHEDULE_PRESETS.some((preset) => preset.cron === cron);
}

/** Loose 5-field cron shape check for inline feedback (the runtime parser stays authoritative). */
function isValidCronShape(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/.test(field));
}

function promotionThresholdDefault(taskName: string): number | undefined {
  if (taskName === "review-user-memories") return 3;
  if (taskName === "promote-primers") return 2;
  return undefined;
}

/* ------------------------------------------------------------ small controls */

function Field(props: { label: string; fieldKey: string; description: string; children: ReactNode }) {
  return (
    <div className="ckmc-field">
      <div className="ckmc-fieldHead">
        <span className="ckmc-fieldLabel">{props.label}</span>
        <span className="ckmc-fieldKey">{props.fieldKey}</span>
      </div>
      <span className="ckmc-fieldDesc">{props.description}</span>
      {props.children}
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="ckmc-section">
      <h4 className="ckmc-sectionHead">{props.title}</h4>
      {props.children}
    </section>
  );
}

function Toggle(props: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className={props.checked ? "ckmc-toggle ckmc-toggleOn" : "ckmc-toggle"}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="ckmc-switch" />
      <span className="ckmc-toggleLabel">{props.label}</span>
    </button>
  );
}

function HarnessTabs(props: { value: Harness; onChange: (next: Harness) => void }) {
  return (
    <div className="ckmc-tabs ckmc-harnessTabs">
      {HARNESSES.map((harness) => (
        <button
          key={harness.id}
          type="button"
          className={props.value === harness.id ? "ckmc-tab ckmc-tabActive" : "ckmc-tab"}
          onClick={() => props.onChange(harness.id)}
        >
          {harness.label}
        </button>
      ))}
    </div>
  );
}

function DeleteButton(props: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      className="ckmc-btn ckmc-btnDanger"
      title={props.title ?? "移除"}
      aria-label={props.title ?? "移除"}
      onClick={props.onClick}
    >
      ✕
    </button>
  );
}

/* ------------------------------------------------------------ per-model widget */

interface PerModelSlider {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix: string;
  readonly defaultValue: number;
}

interface PerModelFieldProps {
  readonly label: string;
  readonly configKey: string;
  readonly description: string;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly inputType: "text" | "slider";
  readonly slider?: PerModelSlider;
  readonly defaultPlaceholder: string;
  /** Emit { default, ...overrides } even when only the default is set (schema forbids a bare scalar). */
  readonly alwaysObject?: boolean;
  /** Coerce typed text to a number (blank → undefined). */
  readonly numericText?: boolean;
  /** Quick values offered beside text inputs (e.g. the `never` TTL sentinel). */
  readonly textOptions?: readonly { readonly value: string; readonly label: string }[];
}

/**
 * Scalar-or-{default, model: value} config field: one default control plus
 * optional per-model override rows, each with a delete button. Model keys are
 * typed by hand because the dsh client carries no model catalog.
 */
function PerModelField(props: PerModelFieldProps) {
  const [adding, setAdding] = useState(false);
  const [draftKey, setDraftKey] = useState("");

  const normalized = (): { defaultVal: string | number | undefined; overrides: Record<string, string | number> } => {
    const value = props.value;
    if (value === null || value === undefined) return { defaultVal: undefined, overrides: {} };
    if (isRecord(value)) {
      const { default: fallback, ...rest } = value;
      const overrides: Record<string, string | number> = {};
      for (const [key, entry] of Object.entries(rest)) {
        if (typeof entry === "string" || typeof entry === "number") overrides[key] = entry;
      }
      return { defaultVal: fallback as string | number | undefined, overrides };
    }
    if (typeof value === "string" || typeof value === "number") return { defaultVal: value, overrides: {} };
    return { defaultVal: undefined, overrides: {} };
  };

  const coerce = (value: string | number | undefined): string | number | undefined => {
    if (value === undefined || value === "") return undefined;
    if (props.numericText === true && typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  };

  const buildValue = (
    defaultVal: string | number | undefined,
    overrides: Record<string, string | number>,
  ): unknown => {
    const hasDefault = defaultVal !== undefined && defaultVal !== "";
    if (props.alwaysObject === true) {
      if (!hasDefault && Object.keys(overrides).length === 0) return undefined;
      return hasDefault ? { default: defaultVal, ...overrides } : { ...overrides };
    }
    if (Object.keys(overrides).length === 0) return defaultVal;
    return { default: defaultVal, ...overrides };
  };

  const { defaultVal, overrides } = normalized();

  const setDefault = (value: string | number | undefined) =>
    props.onChange(buildValue(coerce(value), overrides));

  const setOverride = (model: string, value: string | number) => {
    const coerced = coerce(value);
    if (coerced === undefined) return;
    props.onChange(buildValue(defaultVal, { ...overrides, [model]: coerced }));
  };

  const removeOverride = (model: string) => {
    const rest = { ...overrides };
    delete rest[model];
    props.onChange(buildValue(defaultVal, rest));
  };

  const addOverride = () => {
    const model = draftKey.trim();
    if (model === "") return;
    let seed: string | number;
    if (props.inputType === "slider" && props.slider !== undefined) {
      seed = props.slider.defaultValue;
    } else if (props.numericText === true) {
      const asNumber = typeof defaultVal === "number" ? defaultVal : Number(defaultVal);
      const placeholderNumber = Number(props.defaultPlaceholder);
      seed =
        Number.isFinite(asNumber) && asNumber > 0
          ? asNumber
          : Number.isFinite(placeholderNumber) && placeholderNumber > 0
            ? placeholderNumber
            : 0;
    } else {
      seed = defaultVal ?? props.defaultPlaceholder;
    }
    props.onChange(buildValue(defaultVal, { ...overrides, [model]: seed }));
    setDraftKey("");
    setAdding(false);
  };

  const textOptions = props.textOptions ?? [];
  const selectedOption =
    textOptions.some((option) => option.value === String(defaultVal ?? "")) ? String(defaultVal) : "";

  const renderTextInput = (value: string | number | undefined, onInput: (next: string) => void) => (
    <div className="ckmc-inlineRow">
      {textOptions.length > 0 && (
        <select className="ckmc-input ckmc-inputShort" value={selectedOption} onChange={(event) => onInput(event.currentTarget.value)}>
          <option value="">自定义…</option>
          {textOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <input
        className="ckmc-input"
        type="text"
        value={String(value ?? "")}
        placeholder={props.defaultPlaceholder}
        onChange={(event) => onInput(event.currentTarget.value)}
      />
    </div>
  );

  const overrideKeys = Object.keys(overrides);

  return (
    <Field label={props.label} fieldKey={props.configKey} description={props.description}>
      <div className="ckmc-overrideRow">
        <span className="ckmc-overrideKey">default</span>
        {props.inputType === "slider" && props.slider !== undefined ? (
          <div className="ckmc-sliderRow">
            <input
              className="ckmc-slider"
              type="range"
              min={props.slider.min}
              max={props.slider.max}
              step={props.slider.step}
              value={defaultVal !== undefined && defaultVal !== "" ? Number(defaultVal) : props.slider.defaultValue}
              onChange={(event) => setDefault(Number(event.currentTarget.value))}
            />
            <span className="ckmc-sliderValue">
              {defaultVal !== undefined && defaultVal !== "" ? Number(defaultVal) : props.slider.defaultValue}
              {props.slider.suffix}
            </span>
          </div>
        ) : (
          renderTextInput(defaultVal, (value) => setDefault(value === "" ? undefined : value))
        )}
      </div>

      {overrideKeys.length > 0 && (
        <div className="ckmc-overrides">
          {overrideKeys.map((model) => (
            <div key={model} className="ckmc-overrideRow">
              <span className="ckmc-overrideKey ckmc-mono" title={model}>
                {model}
              </span>
              {props.inputType === "slider" && props.slider !== undefined ? (
                <div className="ckmc-sliderRow">
                  <input
                    className="ckmc-slider"
                    type="range"
                    min={props.slider.min}
                    max={props.slider.max}
                    step={props.slider.step}
                    value={Number(overrides[model])}
                    onChange={(event) => setOverride(model, Number(event.currentTarget.value))}
                  />
                  <span className="ckmc-sliderValue">
                    {Number(overrides[model])}
                    {props.slider.suffix}
                  </span>
                </div>
              ) : (
                renderTextInput(overrides[model], (value) => {
                  if (value !== "") setOverride(model, value);
                })
              )}
              <DeleteButton onClick={() => removeOverride(model)} title={`移除 ${model} 覆盖`} />
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="ckmc-inlineRow ckmc-addRow">
          <input
            className="ckmc-input ckmc-mono"
            type="text"
            value={draftKey}
            placeholder="provider/model 或 default"
            onChange={(event) => setDraftKey(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addOverride();
              }
            }}
          />
          <button type="button" className="ckmc-btn" onClick={addOverride}>
            添加
          </button>
          <button type="button" className="ckmc-btn" onClick={() => setAdding(false)}>
            取消
          </button>
        </div>
      )}
      {!adding && (
        <button type="button" className="ckmc-btn ckmc-addBtn" onClick={() => setAdding(true)}>
          + 添加模型覆盖
        </button>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------ harness model block */

interface HarnessModelFieldsProps {
  readonly agent: "historian" | "dreamer";
  readonly harness: Harness;
  readonly value: unknown;
  readonly onChange: (block: Record<string, unknown>) => void;
}

/**
 * Strict per-harness model block (model / qualifier / fallback_models). Model
 * ids are plain text: dsh has no model catalog, and dsh resolves Magic Context
 * agent models from dsh agent options anyway.
 */
function HarnessModelFields(props: HarnessModelFieldsProps) {
  const block = record(props.value);
  const key = qualifierKeyFor(props.harness);
  const label = qualifierLabelFor(props.harness);

  const updateBlock = (patch: Record<string, unknown>) =>
    props.onChange(pruneUndefined({ ...block, ...patch }));

  const fallbacks = fallbackEntries(block.fallback_models);

  const updateFallback = (index: number, entry: ModelEntry | undefined) => {
    const next = fallbacks.slice();
    if (entry !== undefined) next[index] = entry;
    else next.splice(index, 1);
    updateBlock({ fallback_models: next.length > 0 ? next : undefined });
  };

  return (
    <div className="ckmc-harnessBlock">
      <Field
        label="Model"
        fieldKey={`${props.agent}.${props.harness}.model`}
        description={`Primary model for the ${props.agent} ${props.harness} harness`}
      >
        <input
          className="ckmc-input ckmc-mono"
          type="text"
          value={modelIdOf(block.model) ?? ""}
          placeholder="provider/model"
          onChange={(event) =>
            updateBlock({
              model: entryWithModel(block.model, props.harness, event.currentTarget.value || undefined),
            })
          }
        />
      </Field>

      <Field
        label={`Primary ${label}`}
        fieldKey={key}
        description="Stored on this model entry and used only by this harness."
      >
        {props.harness === "opencode" ? (
          <input
            className="ckmc-input"
            type="text"
            value={modelQualifierOf(block.model, props.harness) ?? ""}
            placeholder="e.g. high"
            onChange={(event) =>
              updateBlock({ model: entryWithQualifier(modelIdOf(block.model), props.harness, event.currentTarget.value || undefined) })
            }
          />
        ) : (
          <select
            className="ckmc-input"
            value={modelQualifierOf(block.model, props.harness) ?? ""}
            onChange={(event) =>
              updateBlock({ model: entryWithQualifier(modelIdOf(block.model), props.harness, event.currentTarget.value || undefined) })
            }
          >
            <option value="">Use harness default</option>
            {thinkingLevelsFor(props.harness).map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label={`Default ${label}`}
        fieldKey={key}
        description="Used when the primary entry does not specify its own qualifier."
      >
        {props.harness === "opencode" ? (
          <input
            className="ckmc-input"
            type="text"
            value={typeof block[key] === "string" ? (block[key] as string) : ""}
            placeholder="Use harness default"
            onChange={(event) => updateBlock({ [key]: event.currentTarget.value || undefined })}
          />
        ) : (
          <select
            className="ckmc-input"
            value={typeof block[key] === "string" ? (block[key] as string) : ""}
            onChange={(event) => updateBlock({ [key]: event.currentTarget.value || undefined })}
          >
            <option value="">Use harness default</option>
            {thinkingLevelsFor(props.harness).map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="Fallback Models"
        fieldKey={`${props.agent}.${props.harness}.fallback_models`}
        description={`Fallback entries keep their own ${label} and never inherit the primary entry's value.`}
      >
        {fallbacks.length === 0 ? (
          <span className="ckmc-emptyLine">使用内置回退链</span>
        ) : (
          <div className="ckmc-overrides">
            {fallbacks.map((entry, index) => (
              <div key={`${modelIdOf(entry)}-${index}`} className="ckmc-overrideRow">
                <input
                  className="ckmc-input ckmc-mono"
                  type="text"
                  value={modelIdOf(entry) ?? ""}
                  placeholder="provider/model"
                  onChange={(event) =>
                    updateFallback(index, entryWithModel(entry, props.harness, event.currentTarget.value || undefined))
                  }
                />
                {props.harness === "opencode" ? (
                  <input
                    className="ckmc-input ckmc-inputShort"
                    type="text"
                    value={modelQualifierOf(entry, props.harness) ?? ""}
                    placeholder={label}
                    onChange={(event) =>
                      updateFallback(
                        index,
                        entryWithQualifier(modelIdOf(entry), props.harness, event.currentTarget.value || undefined),
                      )
                    }
                  />
                ) : (
                  <select
                    className="ckmc-input ckmc-inputShort"
                    value={modelQualifierOf(entry, props.harness) ?? ""}
                    onChange={(event) =>
                      updateFallback(
                        index,
                        entryWithQualifier(modelIdOf(entry), props.harness, event.currentTarget.value || undefined),
                      )
                    }
                  >
                    <option value="">默认</option>
                    {thinkingLevelsFor(props.harness).map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                )}
                <DeleteButton onClick={() => updateFallback(index, undefined)} title="移除此回退模型" />
              </div>
            ))}
          </div>
        )}
        <FallbackAdder
          onAdd={(model) => updateBlock({ fallback_models: [...fallbacks, entryWithModel(undefined, props.harness, model)] })}
        />
      </Field>
    </div>
  );
}

function FallbackAdder(props: { onAdd: (model: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="ckmc-inlineRow ckmc-addRow">
      <input
        className="ckmc-input ckmc-mono"
        type="text"
        value={draft}
        placeholder="— 添加回退模型 —"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draft.trim() !== "") {
            event.preventDefault();
            props.onAdd(draft.trim());
            setDraft("");
          }
        }}
      />
      <button
        type="button"
        className="ckmc-btn"
        onClick={() => {
          if (draft.trim() === "") return;
          props.onAdd(draft.trim());
          setDraft("");
        }}
      >
        添加
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ dreamer schedules */

function DreamerSchedules(props: {
  readonly tasks: Record<string, unknown>;
  readonly onChange: (tasks: Record<string, unknown>) => void;
}) {
  const [custom, setCustom] = useState<Record<string, boolean>>({});

  const scheduleOf = (meta: DreamTaskMeta): string => {
    const stored = props.tasks[meta.name];
    const schedule = isRecord(stored) ? stored.schedule : undefined;
    return typeof schedule === "string" ? schedule : meta.defaultSchedule;
  };

  const updateTask = (meta: DreamTaskMeta, patch: Record<string, unknown>) => {
    const stored = record(props.tasks[meta.name]);
    const entry: Record<string, unknown> = { ...stored, ...patch };
    if (entry.schedule === undefined) entry.schedule = meta.defaultSchedule;
    props.onChange({ ...props.tasks, [meta.name]: pruneUndefined(entry) });
  };

  return (
    <div>
      {DREAM_TASKS.map((meta) => {
        const schedule = scheduleOf(meta);
        const customMode = custom[meta.name] === true || (schedule.trim() !== "" && !isPresetSchedule(schedule));
        const selectValue = customMode ? CUSTOM_SCHEDULE : schedule;
        const stored = record(props.tasks[meta.name]);
        const thresholdDefault = promotionThresholdDefault(meta.name);
        return (
          <div key={meta.name} className="ckmc-taskRow">
            <div className="ckmc-fieldHead">
              <span className="ckmc-fieldLabel">{meta.label}</span>
              <span className="ckmc-fieldKey ckmc-mono">{meta.name}</span>
            </div>
            <span className="ckmc-fieldDesc">{meta.description}</span>
            <div className="ckmc-inlineRow">
              <select
                className="ckmc-input"
                value={selectValue}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (next === CUSTOM_SCHEDULE) {
                    setCustom((previous) => ({ ...previous, [meta.name]: true }));
                    if (schedule.trim() === "") updateTask(meta, { schedule: "0 3 * * *" });
                  } else {
                    setCustom((previous) => ({ ...previous, [meta.name]: false }));
                    updateTask(meta, { schedule: next });
                  }
                }}
              >
                {SCHEDULE_PRESETS.map((preset) => (
                  <option key={preset.cron || "off"} value={preset.cron}>
                    {preset.label}
                  </option>
                ))}
                <option value={CUSTOM_SCHEDULE}>自定义 cron…</option>
              </select>
            </div>
            {customMode && (
              <div className="ckmc-inlineRow">
                <input
                  className="ckmc-input ckmc-mono"
                  type="text"
                  value={schedule}
                  placeholder="0 3 * * *  (分 时 日 月 周)"
                  onChange={(event) => updateTask(meta, { schedule: event.currentTarget.value })}
                />
                {!isValidCronShape(schedule) && <span className="ckmc-hintInline">cron 需要 5 个字段</span>}
              </div>
            )}
            {thresholdDefault !== undefined && schedule.trim() !== "" && (
              <div className="ckmc-inlineRow">
                <span className="ckmc-fieldDesc">
                  {meta.name === "promote-primers"
                    ? "提升阈值（2–20 个重复来源日，默认 2）"
                    : "提升阈值（2–20 次观察，默认 3）"}
                </span>
                <input
                  className="ckmc-input ckmc-inputShort"
                  type="number"
                  min={2}
                  max={20}
                  value={typeof stored.promotion_threshold === "number" ? stored.promotion_threshold : thresholdDefault}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    updateTask(meta, { promotion_threshold: next === "" ? undefined : Number(next) });
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------ sticky section header */

/**
 * True while a `position: sticky` header has left its natural resting spot,
 * i.e. while it is pinned to the top of its scroll container. The flag drives
 * the stuck border + shadow; without it the bar would show a divider even when
 * the pane is not scrolled.
 *
 * The `ref` belongs to a 1x1 sentinel parked at the section root's own top
 * edge — exactly where the header rests before it pins. While the sentinel is
 * on screen the header is still in natural flow; once it is scrolled out, the
 * header can only be stuck. An IntersectionObserver does the watching instead
 * of scroll listeners: the observer derives the real scrollport itself (the
 * host renders every section into one pane, and that pane is not knowable at
 * mount time) and re-runs on resize without any rAF bookkeeping.
 */
function useStuck(node: HTMLElement | null): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      setStuck(!entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return stuck;
}

/* ------------------------------------------------------------ the form */

export interface ConfigFormProps {
  readonly state: ConfigSnapshotState;
  readonly onRefresh: () => void;
  readonly onSave: (content: string) => Promise<UserConfigSaveOutcome>;
}

type StatusTone = "ok" | "err";

/**
 * Editable user-config pane: Form / Raw JSONC tabs over
 * ~/.config/cortexkit/magic-context.jsonc. The form never writes on its own —
 * every save goes through the host endpoint, which re-validates and refuses to
 * clobber an unparseable file.
 */
export function ConfigForm(props: ConfigFormProps) {
  const [tab, setTab] = useState<"form" | "raw">("form");
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [rawEdit, setRawEdit] = useState<string | null>(null);
  const [status, setStatus] = useState<{ readonly tone: StatusTone; readonly text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [historianHarness, setHistorianHarness] = useState<Harness>("opencode");
  const [dreamerHarness, setDreamerHarness] = useState<Harness>("opencode");

  // Sticky header (tabs + actions + config-source line): the pane is a long
  // form, so the controls stay reachable instead of scrolling away. The ref is
  // the sentinel sitting just above the bar that tells us when it has pinned.
  const [stickySentinel, setStickySentinel] = useState<HTMLDivElement | null>(null);
  const headerStuck = useStuck(stickySentinel);

  const config = props.state.config;
  const content = config === null ? "" : config.content;

  const parsed = useMemo(() => parseConfigContent(content), [content]);
  const parseError = (config !== null && config.parseError !== undefined ? config.parseError : null) ?? parsed.error;
  const readError = config !== null && config.readError !== undefined ? config.readError : null;
  const exists = config !== null && config.exists;
  const blocked = readError !== null || parseError !== null;

  // Repopulate the form whenever the underlying file text changes; a broken
  // file never populates the form (the raw editor is the only way through).
  useEffect(() => {
    if (parseError === null) setFormData(parsed.value);
  }, [parsed, parseError]);

  useEffect(() => {
    if (parseError !== null) {
      setTab("raw");
      setRawEdit(null);
    }
  }, [parseError]);

  const dirty = parseError === null && JSON.stringify(formData) !== JSON.stringify(parsed.value);
  const rawDirty = rawEdit !== null && rawEdit !== content;

  const flash = (tone: StatusTone, text: string, ms: number) => {
    setStatus({ tone, text });
    setTimeout(() => setStatus((current) => (current !== null && current.text === text ? null : current)), ms);
  };

  const save = async (payload: string) => {
    setSaving(true);
    try {
      const outcome = await props.onSave(payload);
      if (outcome.ok) {
        flash("ok", "✓ 已保存，将于下次会话生效", 2500);
        props.onRefresh();
      } else {
        flash("err", `✕ 错误：${outcome.error ?? "保存失败"}`, 4000);
      }
    } catch (error) {
      flash("err", `✕ 错误：${error instanceof Error ? error.message : String(error)}`, 4000);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: string, value: unknown) => setFormData((current) => setNested(current, key, value));

  const handleFormSave = () => {
    if (blocked) return;
    const merged: Record<string, unknown> = { ...parsed.value, ...formData };
    // Deep-merge the known nested blocks so unknown sub-keys the form does not
    // expose survive a structured save.
    for (const key of [
      "embedding",
      "memory",
      "sqlite",
      "system_prompt_injection",
      "caveman_text_compression",
      "mural",
      "prompt_surface",
      "storage",
      "compaction",
      "dreamer",
      "historian",
      "todowrite",
      "pi",
    ]) {
      if (isRecord(formData[key])) {
        merged[key] = { ...record(parsed.value[key]), ...(formData[key] as Record<string, unknown>) };
      }
    }
    void save(toJson(merged));
  };

  const handleRawSave = () => {
    if (rawEdit !== null) void save(rawEdit);
  };

  const renderField = (field: FieldDef) => {
    const raw = getNested(formData, field.key);
    const objectValue = isRecord(raw);
    const scalar = objectValue ? raw.default : raw;

    if (field.type === "boolean") {
      const checked = typeof raw === "boolean" ? raw : field.defaultValue === undefined ? true : Boolean(field.defaultValue);
      return (
        <Field key={field.key} label={field.label} fieldKey={field.key} description={field.description}>
          <Toggle checked={checked} label={checked ? "Enabled" : "Disabled"} onChange={(next) => update(field.key, next)} />
        </Field>
      );
    }

    if (field.type === "select") {
      return (
        <Field key={field.key} label={field.label} fieldKey={field.key} description={field.description}>
          <select className="ckmc-input" value={String(raw ?? "")} onChange={(event) => update(field.key, event.currentTarget.value)}>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      );
    }

    if (field.type === "number" && RANGE_SLIDER_FIELDS.has(field.key) && !objectValue) {
      const range = rangeConfigFor(field.key);
      const value = scalar !== undefined && scalar !== null ? Number(scalar) : range.defaultValue;
      return (
        <Field key={field.key} label={field.label} fieldKey={field.key} description={field.description}>
          <div className="ckmc-sliderRow">
            <input
              className="ckmc-slider"
              type="range"
              min={range.min}
              max={range.max}
              step={range.step}
              value={value}
              onChange={(event) => update(field.key, Number(event.currentTarget.value))}
            />
            <span className="ckmc-sliderValue">
              {value}
              {range.suffix}
            </span>
          </div>
        </Field>
      );
    }

    if (field.type === "number") {
      const isProtected = field.key === "protected_tokens";
      const value = scalar === undefined || scalar === null ? "" : String(scalar);
      return (
        <Field key={field.key} label={field.label} fieldKey={field.key} description={field.description}>
          <input
            className="ckmc-input"
            type="number"
            min={isProtected ? 4000 : undefined}
            max={isProtected ? 1000000 : undefined}
            value={value}
            placeholder={isProtected ? "derived" : "default"}
            onChange={(event) => {
              const next = event.currentTarget.value;
              update(field.key, next.trim() === "" ? undefined : Number(next));
            }}
          />
        </Field>
      );
    }

    const value = scalar === undefined || scalar === null ? "" : String(scalar);
    return (
      <Field key={field.key} label={field.label} fieldKey={field.key} description={field.description}>
        <input
          className="ckmc-input"
          type="text"
          value={value}
          placeholder="default"
          onChange={(event) => {
            const next = event.currentTarget.value;
            update(field.key, field.key === "language" && next.trim() === "" ? undefined : next);
          }}
        />
      </Field>
    );
  };

  const fieldsFor = (section: string) => FIELD_DEFS.filter((field) => field.section === section).map(renderField);

  /* ---- sub-blocks ---- */

  const thresholds = () => (
    <>
      <PerModelField
        label="Cache TTL"
        configKey="cache_ttl"
        description="How long to wait before executing queued operations."
        value={getNested(formData, "cache_ttl")}
        onChange={(value) => update("cache_ttl", value)}
        inputType="text"
        defaultPlaceholder="5m"
        textOptions={[{ value: "never", label: "Never (keep warm)" }]}
      />
      <PerModelField
        label="Execute Threshold %"
        configKey="execute_threshold_percentage"
        description="Context usage percentage (20–90) at which queued drops execute. The safe-window cap is 90%."
        value={getNested(formData, "execute_threshold_percentage")}
        onChange={(value) => update("execute_threshold_percentage", value)}
        inputType="slider"
        slider={{ min: 20, max: 90, step: 1, suffix: "%", defaultValue: 65 }}
        defaultPlaceholder="65"
      />
      <PerModelField
        label="Execute Threshold (tokens)"
        configKey="execute_threshold_tokens"
        description="Optional absolute-tokens threshold. When set for a model, overrides the percentage above. Per-model map only (use 'default' for all unlisted models). Clamped to 90% × context_limit at runtime."
        value={getNested(formData, "execute_threshold_tokens")}
        onChange={(value) => update("execute_threshold_tokens", value)}
        inputType="text"
        alwaysObject
        numericText
        defaultPlaceholder="150000"
      />
      <PerModelField
        label="Output Reserve"
        configKey="output_reserve"
        description="Reserve output tokens from the shared context window. Set 0 to disable the reservation. User-level only."
        value={getNested(formData, "output_reserve")}
        onChange={(value) => update("output_reserve", value)}
        inputType="text"
        numericText
        defaultPlaceholder="16384"
      />
    </>
  );

  const commitCluster = () => {
    const block = record(getNested(formData, "commit_cluster_trigger"));
    const enabled = block.enabled === undefined ? true : block.enabled === true;
    const minClusters = typeof block.min_clusters === "number" ? block.min_clusters : 3;
    return (
      <>
        <Field
          label="Commit Cluster Trigger"
          fieldKey="commit_cluster_trigger.enabled"
          description="Fire historian when enough git commit clusters accumulate in the unsummarized conversation tail. A commit cluster is a distinct work phase where the agent made git commits, separated by meaningful user turns."
        >
          <Toggle
            checked={enabled}
            label={enabled ? "Enabled" : "Disabled"}
            onChange={(next) => update("commit_cluster_trigger", { ...block, enabled: next })}
          />
        </Field>
        {enabled && (
          <Field label="Min Clusters" fieldKey="commit_cluster_trigger.min_clusters" description="Minimum number of commit clusters required to trigger historian">
            <input
              className="ckmc-input"
              type="number"
              min={1}
              value={minClusters}
              onChange={(event) => {
                const next = event.currentTarget.value;
                update("commit_cluster_trigger", { ...block, min_clusters: next === "" ? 3 : Math.max(1, Number(next)) });
              }}
            />
          </Field>
        )}
      </>
    );
  };

  const embeddingBlock = () => {
    const embedding = record(getNested(formData, "embedding"));
    const provider = typeof embedding.provider === "string" ? embedding.provider : "local";
    const remote = provider === "openai-compatible";
    const setEmbedding = (patch: Record<string, unknown>) => update("embedding", pruneUndefined({ ...embedding, ...patch }));
    return (
      <div className="ckmc-subBlock">
        <Field label="Embedding Provider" fieldKey="embedding.provider" description="Provider for memory semantic search">
          <div className="ckmc-tabs">
            {(["local", "openai-compatible", "off"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={provider === option ? "ckmc-tab ckmc-tabActive" : "ckmc-tab"}
                onClick={() =>
                  setEmbedding({
                    provider: option,
                    // Keep the stored block schema-valid: local/off must not
                    // carry remote-only keys that would fail validation.
                    endpoint: option === "openai-compatible" ? embedding.endpoint : undefined,
                    model: option === "openai-compatible" ? embedding.model : undefined,
                  })
                }
              >
                {option === "local" ? "Local" : option === "openai-compatible" ? "OpenAI Compatible" : "Off"}
              </button>
            ))}
          </div>
        </Field>
        {provider === "local" && (
          <Field
            label="Model dtype"
            fieldKey="embedding.local_dtype"
            description="ONNX dtype for the local embedding model. The default fp32 keeps today's behavior; quantized choices use less memory."
          >
            <select
              className="ckmc-input"
              value={typeof embedding.local_dtype === "string" ? embedding.local_dtype : "fp32"}
              onChange={(event) =>
                setEmbedding({ local_dtype: event.currentTarget.value === "fp32" ? undefined : event.currentTarget.value })
              }
            >
              {["auto", "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16", "q2", "q2f16", "q1", "q1f16"].map((dtype) => (
                <option key={dtype} value={dtype}>
                  {dtype}
                </option>
              ))}
            </select>
          </Field>
        )}
        {remote && (
          <>
            <Field label="Model" fieldKey="embedding.model" description="Embedding model name (e.g., text-embedding-3-small)">
              <input
                className="ckmc-input"
                type="text"
                value={typeof embedding.model === "string" ? embedding.model : ""}
                placeholder="text-embedding-3-small"
                onChange={(event) => setEmbedding({ model: event.currentTarget.value || undefined })}
              />
            </Field>
            <Field label="Endpoint" fieldKey="embedding.endpoint" description="API endpoint URL">
              <input
                className="ckmc-input"
                type="text"
                value={typeof embedding.endpoint === "string" ? embedding.endpoint : ""}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => setEmbedding({ endpoint: event.currentTarget.value || undefined })}
              />
            </Field>
            <Field label="API Key" fieldKey="embedding.api_key" description="Authentication key for the embedding API">
              <input
                className="ckmc-input"
                type="password"
                value={typeof embedding.api_key === "string" ? embedding.api_key : ""}
                placeholder="sk-..."
                onChange={(event) => setEmbedding({ api_key: event.currentTarget.value || undefined })}
              />
            </Field>
          </>
        )}
      </div>
    );
  };

  const dreamerBlock = () => {
    const dreamer = record(getNested(formData, "dreamer"));
    const enabled = dreamer.disable !== true;
    const injectDocs = dreamer.inject_docs === undefined ? true : dreamer.inject_docs === true;
    return (
      <>
        <Field
          label="Dreamer agent enabled"
          fieldKey="dreamer.disable"
          description="Controls whether the Dreamer hidden agent is registered. To keep manual /ctx-dream but disable automatic runs, leave enabled and set every schedule to Disabled."
        >
          <Toggle
            checked={enabled}
            label={enabled ? "Enabled" : "Disabled"}
            onChange={(next) => {
              const stored = record(getNested(formData, "dreamer"));
              const { enabled: _legacyEnabled, ...rest } = stored;
              // The runtime control is dreamer.disable; a stale dreamer.enabled
              // key (legacy shape) is dropped so the two can never disagree.
              update("dreamer", pruneUndefined({ ...rest, disable: next ? undefined : true }));
            }}
          />
        </Field>
        <Field label="Inject Docs" fieldKey="dreamer.inject_docs" description="Inject ARCHITECTURE.md and STRUCTURE.md into agent context">
          <Toggle
            checked={injectDocs}
            label={injectDocs ? "Enabled" : "Disabled"}
            onChange={(next) => update("dreamer", pruneUndefined({ ...dreamer, inject_docs: next }))}
          />
        </Field>
        <div className="ckmc-subBlock">
          <HarnessTabs value={dreamerHarness} onChange={setDreamerHarness} />
          <HarnessModelFields
            agent="dreamer"
            harness={dreamerHarness}
            value={record(dreamer[dreamerHarness])}
            onChange={(block) => update("dreamer", pruneUndefined({ ...dreamer, [dreamerHarness]: block }))}
          />
        </div>
        <div className="ckmc-subBlock">
          <span className="ckmc-subHead">Task schedules</span>
          <span className="ckmc-fieldDesc">
            {"Schedules apply once for every harness. Model overrides per task live in the raw JSONC (dreamer.<harness>.tasks)."}
          </span>
          <DreamerSchedules
            tasks={record(dreamer.tasks)}
            onChange={(tasks) => update("dreamer", pruneUndefined({ ...dreamer, tasks }))}
          />
        </div>
      </>
    );
  };

  const promptSurfaceBlock = () => {
    const promptSurface = record(getNested(formData, "prompt_surface"));
    const preset = promptSurface.default === "light" ? "light" : "full";
    const setPromptSurface = (patch: Record<string, unknown>) =>
      update("prompt_surface", pruneUndefined({ ...promptSurface, ...patch }));
    return (
      <>
        <span className="ckmc-fieldDesc">
          Choose the built-in full or light preset. Model routes use the literal provider/model or provider/* form and are case-sensitive; additional
          slashes in model IDs are preserved.
        </span>
        <Field label="Default preset" fieldKey="prompt_surface.default" description="Fallback prompt-surface preset.">
          <select className="ckmc-input" value={preset} onChange={(event) => setPromptSurface({ default: event.currentTarget.value })}>
            <option value="full">full</option>
            <option value="light">light</option>
          </select>
        </Field>
        <JsonObjectEditor
          label="Model routes"
          fieldKey="prompt_surface.models"
          description="JSON object of provider/model or provider/* keys to full or light. Leave empty for default routing."
          value={promptSurface.models}
          onChange={(next) => setPromptSurface({ models: next })}
        />
        <Field
          label="Guidance override path"
          fieldKey="prompt_surface.guidance_override_path"
          description="User-only path to a complete primary guidance section. Relative paths resolve from the user config file."
        >
          <input
            className="ckmc-input"
            type="text"
            value={typeof promptSurface.guidance_override_path === "string" ? promptSurface.guidance_override_path : ""}
            placeholder="path/to/guidance.md"
            onChange={(event) => setPromptSurface({ guidance_override_path: event.currentTarget.value || undefined })}
          />
        </Field>
        <JsonObjectEditor
          label="Tool-description overrides"
          fieldKey="prompt_surface.tool_descriptions"
          description="User-only JSON object keyed by tool ID. Only top-level descriptions change; IDs, parameter schemas, and parameter descriptions remain fixed."
          value={promptSurface.tool_descriptions}
          onChange={(next) => setPromptSurface({ tool_descriptions: next })}
        />
      </>
    );
  };

  const historyRecallBlock = () => {
    const temporalAwareness = (() => {
      const value = getNested(formData, "temporal_awareness");
      return value === undefined || value === null ? true : Boolean(value);
    })();
    const autoSearch = record(getNested(formData, "memory.auto_search"));
    const autoSearchEnabled = autoSearch.enabled === undefined ? true : autoSearch.enabled === true;
    const setAutoSearch = (patch: Record<string, unknown>) =>
      update("memory.auto_search", pruneUndefined({ ...autoSearch, ...patch }));
    const gitCommit = record(getNested(formData, "memory.git_commit_indexing"));
    const gitCommitEnabled = gitCommit.enabled === true;
    const setGitCommit = (patch: Record<string, unknown>) =>
      update("memory.git_commit_indexing", pruneUndefined({ ...gitCommit, ...patch }));
    const caveman = record(getNested(formData, "caveman_text_compression"));
    const cavemanEnabled = caveman.enabled === true;
    const setCaveman = (patch: Record<string, unknown>) =>
      update("caveman_text_compression", pruneUndefined({ ...caveman, ...patch }));

    return (
      <>
        <span className="ckmc-fieldDesc">Recall and history features. Temporal awareness and auto-search are on by default; the rest are opt-in.</span>
        <Field
          label="Temporal Awareness"
          fieldKey="temporal_awareness"
          description="Inject elapsed-time markers between user messages with >5 min gaps, and add date attributes on rendered compartments. On by default."
        >
          <Toggle
            checked={temporalAwareness}
            label={temporalAwareness ? "Enabled" : "Disabled"}
            onChange={(next) => update("temporal_awareness", next)}
          />
        </Field>
        <Field
          label="Auto Search Hint"
          fieldKey="memory.auto_search.enabled"
          description="On each new user message, run ctx_search in the background and append a compact hint block when the top hit clears the score threshold. On by default."
        >
          <Toggle checked={autoSearchEnabled} label={autoSearchEnabled ? "Enabled" : "Disabled"} onChange={(next) => setAutoSearch({ enabled: next })} />
        </Field>
        {autoSearchEnabled && (
          <>
            <Field label="Score Threshold" fieldKey="memory.auto_search.score_threshold" description="Minimum top-hit score for the hint to fire. Range 0.30–0.95, default 0.55.">
              <input
                className="ckmc-input"
                type="number"
                min={0.3}
                max={0.95}
                step={0.05}
                value={typeof autoSearch.score_threshold === "number" ? autoSearch.score_threshold : 0.55}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setAutoSearch({ score_threshold: next === "" ? 0.55 : Math.max(0.3, Math.min(0.95, Number(next))) });
                }}
              />
            </Field>
            <Field label="Min Prompt Chars" fieldKey="memory.auto_search.min_prompt_chars" description="Skip the hint when a user message is shorter than this. Range 5–500, default 20.">
              <input
                className="ckmc-input"
                type="number"
                min={5}
                max={500}
                value={typeof autoSearch.min_prompt_chars === "number" ? autoSearch.min_prompt_chars : 20}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setAutoSearch({ min_prompt_chars: next === "" ? 20 : Math.max(5, Math.min(500, Number(next))) });
                }}
              />
            </Field>
          </>
        )}
        <Field
          label="Git Commit Indexing"
          fieldKey="memory.git_commit_indexing.enabled"
          description="Index HEAD non-merge commits into ctx_search as a 4th source alongside memories, facts, and message history. Off by default."
        >
          <Toggle checked={gitCommitEnabled} label={gitCommitEnabled ? "Enabled" : "Disabled"} onChange={(next) => setGitCommit({ enabled: next })} />
        </Field>
        {gitCommitEnabled && (
          <>
            <Field label="History Window (days)" fieldKey="memory.git_commit_indexing.since_days" description="Days of HEAD history to index. Range 7–3650, default 365.">
              <input
                className="ckmc-input"
                type="number"
                min={7}
                max={3650}
                value={typeof gitCommit.since_days === "number" ? gitCommit.since_days : 365}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setGitCommit({ since_days: next === "" ? 365 : Math.max(7, Math.min(3650, Number(next))) });
                }}
              />
            </Field>
            <Field label="Max Commits" fieldKey="memory.git_commit_indexing.max_commits" description="Maximum commits kept per project. Range 100–20000, default 2000.">
              <input
                className="ckmc-input"
                type="number"
                min={100}
                max={20000}
                value={typeof gitCommit.max_commits === "number" ? gitCommit.max_commits : 2000}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setGitCommit({ max_commits: next === "" ? 2000 : Math.max(100, Math.min(20000, Number(next))) });
                }}
              />
            </Field>
          </>
        )}
        <Field
          label="Caveman Text Compression"
          fieldKey="caveman_text_compression.enabled"
          description="Age-tiered compression for long user/assistant text parts. Active only for primary sessions. Off by default."
        >
          <Toggle checked={cavemanEnabled} label={cavemanEnabled ? "Enabled" : "Disabled"} onChange={(next) => setCaveman({ enabled: next })} />
        </Field>
        {cavemanEnabled && (
          <Field label="Min Chars" fieldKey="caveman_text_compression.min_chars" description="Text parts shorter than this are left untouched. Range 100–10000, default 500.">
            <input
              className="ckmc-input"
              type="number"
              min={100}
              max={10000}
              step={50}
              value={typeof caveman.min_chars === "number" ? caveman.min_chars : 500}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setCaveman({ min_chars: next === "" ? 500 : Math.max(100, Math.min(10000, Number(next))) });
              }}
            />
          </Field>
        )}
      </>
    );
  };

  const advancedBlock = () => {
    const autoUpdate = (() => {
      const value = getNested(formData, "auto_update");
      return value === undefined || value === null ? true : Boolean(value);
    })();
    const keepSubagents = getNested(formData, "keep_subagents") === true;
    const todowrite = record(getNested(formData, "todowrite"));
    const todowriteEnabled = todowrite.enabled === undefined ? true : todowrite.enabled === true;
    const todowriteOverlay = todowrite.overlay === undefined ? true : todowrite.overlay === true;
    const setTodowrite = (patch: Record<string, unknown>) => update("todowrite", pruneUndefined({ ...todowrite, ...patch }));
    const smartDrops = getNested(formData, "smart_drops") === true;
    const sqlite = record(getNested(formData, "sqlite"));
    const setSqlite = (patch: Record<string, unknown>) => update("sqlite", pruneUndefined({ ...sqlite, ...patch }));
    const compaction = record(getNested(formData, "compaction"));
    const compactionEnabled = compaction.enabled === undefined ? true : compaction.enabled === true;
    const storage = record(getNested(formData, "storage"));
    const privatePermissions = storage.enforce_private_permissions === undefined ? true : storage.enforce_private_permissions === true;
    const systemPrompt = record(getNested(formData, "system_prompt_injection"));
    const systemPromptEnabled = systemPrompt.enabled === undefined ? true : systemPrompt.enabled === true;
    const pi = record(getNested(formData, "pi"));
    const piExtensions = Array.isArray(pi.subagent_extensions)
      ? pi.subagent_extensions.filter((entry): entry is string => typeof entry === "string")
      : [];

    return (
      <>
        <span className="ckmc-fieldDesc">Power-user and debug settings. Most users never need these.</span>
        <Field
          label="Auto Update"
          fieldKey="auto_update"
          description="Automatically self-update the plugin to the latest published version on startup. On by default. User-level only."
        >
          <Toggle checked={autoUpdate} label={autoUpdate ? "Enabled" : "Disabled"} onChange={(next) => update("auto_update", next)} />
        </Field>
        <Field
          label="Keep Subagent Sessions"
          fieldKey="keep_subagents"
          description="Retain the child sessions magic-context spawns for its own agents instead of deleting them on success. Useful for debugging; kept sessions accumulate. Off by default."
        >
          <Toggle checked={keepSubagents} label={keepSubagents ? "Enabled" : "Disabled"} onChange={(next) => update("keep_subagents", next)} />
        </Field>
        <Field
          label="Pi Todowrite Tool"
          fieldKey="todowrite.enabled"
          description="Register Magic Context's Pi todowrite task-list tool. OpenCode has its own built-in todowrite, so this only affects Pi."
        >
          <Toggle checked={todowriteEnabled} label={todowriteEnabled ? "Enabled" : "Disabled"} onChange={(next) => setTodowrite({ enabled: next })} />
        </Field>
        {todowriteEnabled && (
          <Field label="Pi Todo Overlay" fieldKey="todowrite.overlay" description="Show the persistent todo overlay above the editor while tasks are active.">
            <Toggle checked={todowriteOverlay} label={todowriteOverlay ? "Enabled" : "Disabled"} onChange={(next) => setTodowrite({ overlay: next })} />
          </Field>
        )}
        <Field
          label="Compaction Management"
          fieldKey="compaction.enabled"
          description="Let Magic Context manage the context window. Turn this off to keep memory and search features while native compaction owns the window. Requires a restart."
        >
          <Toggle checked={compactionEnabled} label={compactionEnabled ? "Enabled" : "Disabled"} onChange={(next) => update("compaction", { ...compaction, enabled: next })} />
        </Field>
        <Field
          label="Private Storage Permissions"
          fieldKey="storage.enforce_private_permissions"
          description="Keep Magic Context directories owner-only (0700) and files owner-only (0600). Disable only when a trusted group manages permissions externally."
        >
          <Toggle
            checked={privatePermissions}
            label={privatePermissions ? "Enabled" : "Disabled"}
            onChange={(next) => update("storage", { ...storage, enforce_private_permissions: next })}
          />
        </Field>
        <Field
          label="System Prompt Injection"
          fieldKey="system_prompt_injection.enabled"
          description="Inject the magic-context guidance text into the system prompt. On by default. Disabling it stops the guidance block entirely."
        >
          <Toggle
            checked={systemPromptEnabled}
            label={systemPromptEnabled ? "Enabled" : "Disabled"}
            onChange={(next) => update("system_prompt_injection", { ...systemPrompt, enabled: next })}
          />
        </Field>
        <Field
          label="Smart Drops"
          fieldKey="smart_drops"
          description="Content-aware reclaim of provably-superseded tool output, on top of the existing auto-drop. Only acts on passes already busting the cache. Off by default."
        >
          <Toggle checked={smartDrops} label={smartDrops ? "Enabled" : "Disabled"} onChange={(next) => update("smart_drops", next)} />
        </Field>
        <Field label="SQLite Cache (MB)" fieldKey="sqlite.cache_size_mb" description="Per-connection page-cache size in MB. Range 8–1024, default 64.">
          <input
            className="ckmc-input"
            type="number"
            min={8}
            max={1024}
            value={typeof sqlite.cache_size_mb === "number" ? sqlite.cache_size_mb : 64}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setSqlite({ cache_size_mb: next === "" ? 64 : Math.max(8, Math.min(1024, Number(next))) });
            }}
          />
        </Field>
        <Field label="SQLite mmap (MB)" fieldKey="sqlite.mmap_size_mb" description="Memory-mapped I/O size in MB. 0 disables mmap. Range 0–4096, default 0.">
          <input
            className="ckmc-input"
            type="number"
            min={0}
            max={4096}
            value={typeof sqlite.mmap_size_mb === "number" ? sqlite.mmap_size_mb : 0}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setSqlite({ mmap_size_mb: next === "" ? 0 : Math.max(0, Math.min(4096, Number(next))) });
            }}
          />
        </Field>
        <Field
          label="Pi Subagent Extensions"
          fieldKey="pi.subagent_extensions"
          description="Optional user-level allowlist for extensions loaded by Pi subagent children. One extension path or package per line."
        >
          <textarea
            className="ckmc-input ckmc-textarea ckmc-textareaShort"
            rows={4}
            value={piExtensions.join("\n")}
            placeholder="extensions/my-tools.ts"
            onChange={(event) => {
              const entries = event.currentTarget.value
                .split("\n")
                .map((entry) => entry.trim())
                .filter((entry) => entry !== "");
              update("pi", pruneUndefined({ ...pi, subagent_extensions: entries.length > 0 ? entries : undefined }));
            }}
          />
        </Field>
      </>
    );
  };

  /* ---- states ---- */

  if (props.state.state === "idle" || (props.state.state === "loading" && config === null)) {
    return <p className="ckmc-loading">读取配置…</p>;
  }

  if (props.state.state === "error" || config === null) {
    return (
      <div className="ckmc-card">
        <h3 className="ckmc-title">Magic Context 配置</h3>
        <p className="ckmc-errorText">
          主机端点不可用：{props.state.error !== null ? props.state.error.message : "unknown"}（需要 host 半侧注册 magicContext/config）
        </p>
        <div className="ckmc-actions">
          <button type="button" className="ckmc-btn" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
      </div>
    );
  }

  if (readError !== null) {
    return (
      <div className="ckmc-card">
        <h3 className="ckmc-title">Magic Context 配置</h3>
        <p className="ckmc-errorText">配置无法读取：{readError}</p>
        <p className="ckmc-hint">{config.path}</p>
        <div className="ckmc-actions">
          <button type="button" className="ckmc-btn" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
      </div>
    );
  }

  const rawValue = rawEdit ?? content;

  return (
    <div className="ckmc-root ckmc-rootColumn">
      <div ref={setStickySentinel} className="ckmc-stickySentinel" aria-hidden="true" />
      <div className={headerStuck ? "ckmc-stickyHead ckmc-stickyHeadStuck" : "ckmc-stickyHead"}>
        <div className="ckmc-toolbar">
          <div className="ckmc-tabs">
            <button type="button" className={tab === "form" ? "ckmc-tab ckmc-tabActive" : "ckmc-tab"} onClick={() => setTab("form")}>
              表单
            </button>
            <button type="button" className={tab === "raw" ? "ckmc-tab ckmc-tabActive" : "ckmc-tab"} onClick={() => setTab("raw")}>
              Raw JSONC
            </button>
          </div>
          <span className="ckmc-spacer" />
          {status !== null && <span className={status.tone === "ok" ? "ckmc-statusOk" : "ckmc-statusErr"}>{status.text}</span>}
          <button type="button" className="ckmc-btn" disabled={props.state.state === "loading"} onClick={props.onRefresh}>
            刷新
          </button>
          {tab === "form" ? (
            <button type="button" className="ckmc-btn ckmc-btnPrimary" disabled={blocked || !dirty || saving} onClick={handleFormSave}>
              保存
            </button>
          ) : (
            <button type="button" className="ckmc-btn ckmc-btnPrimary" disabled={!rawDirty || saving} onClick={handleRawSave}>
              保存
            </button>
          )}
        </div>

        <p className="ckmc-hint">配置源：{config.path}</p>
      </div>

      {!exists && (
        <div className="ckmc-card ckmc-emptyCard">
          <p className="ckmc-desc">尚未找到用户配置文件。可用默认值创建，或在 Raw JSONC 中自行编写。</p>
          <div className="ckmc-actions">
            <button
              type="button"
              className="ckmc-btn ckmc-btnPrimary"
              disabled={saving}
              onClick={() => {
                void save(USER_DEFAULT_CONFIG);
              }}
            >
              使用默认值创建
            </button>
          </div>
        </div>
      )}

      {exists && parseError !== null && (
        <p className="ckmc-errorText">配置解析失败：{parseError}。表单已停用，请在 Raw JSONC 中修正后保存。</p>
      )}

      {tab === "raw" ? (
        <div>
          <textarea
            className="ckmc-input ckmc-textarea"
            spellCheck={false}
            value={rawValue}
            onChange={(event) => setRawEdit(event.currentTarget.value)}
          />
          {rawEdit !== null && (
            <div className="ckmc-actions">
              <button type="button" className="ckmc-btn" onClick={() => setRawEdit(null)}>
                还原
              </button>
            </div>
          )}
        </div>
      ) : parseError !== null ? (
        <p className="ckmc-loading">请切换到 Raw JSONC 修正配置。</p>
      ) : !exists ? null : (
        <div className="ckmc-form">
          <Section title="General">{fieldsFor("General")}</Section>
          <Section title="Thresholds">{thresholds()}</Section>
          <Section title="Mural">{fieldsFor("Mural")}</Section>
          <Section title="Tags & Cleanup">{fieldsFor("Tags & Cleanup")}</Section>
          <Section title="Historian">
            {fieldsFor("Historian")}
            {commitCluster()}
            <div className="ckmc-subBlock">
              <HarnessTabs value={historianHarness} onChange={setHistorianHarness} />
              <HarnessModelFields
                agent="historian"
                harness={historianHarness}
                value={record(record(getNested(formData, "historian"))[historianHarness])}
                onChange={(block) =>
                  update(
                    "historian",
                    pruneUndefined({ ...record(getNested(formData, "historian")), [historianHarness]: block }),
                  )
                }
              />
            </div>
          </Section>
          <Section title="Memory">
            {fieldsFor("Memory")}
            {embeddingBlock()}
          </Section>
          <Section title="Dreamer">{dreamerBlock()}</Section>
          <Section title="Prompt Surface">{promptSurfaceBlock()}</Section>
          <Section title="History & Recall">{historyRecallBlock()}</Section>
          <Section title="Advanced">{advancedBlock()}</Section>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ JSON object editor */

function JsonObjectEditor(props: {
  readonly label: string;
  readonly fieldKey: string;
  readonly description: string;
  readonly value: unknown;
  readonly onChange: (value: Record<string, unknown> | undefined) => void;
}) {
  const serialized = JSON.stringify(isRecord(props.value) ? props.value : {}, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const current = draft ?? serialized;

  return (
    <Field label={props.label} fieldKey={props.fieldKey} description={props.description}>
      <textarea
        className="ckmc-input ckmc-textarea ckmc-textareaShort ckmc-mono"
        spellCheck={false}
        rows={4}
        value={current}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          try {
            const parsed: unknown = JSON.parse(next);
            const object = isRecord(parsed) ? parsed : undefined;
            if (object === undefined) {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            props.onChange(object);
            setDraft(null);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <span className="ckmc-hintInline">需要 JSON 对象</span>}
    </Field>
  );
}
