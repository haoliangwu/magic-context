/*!
 * dsh-magic-context — client bundle.
 *
 * Browser half of the persistent bundle, compiled by scripts/build-client.mjs
 * into the `window.__ModuleLoader__.load({ id: "@cortexkit/dsh-magic-context",
 * factory: (require) => ... })` classic-script shape (banner/intro/footer, see
 * the reference tsdown pipeline in the harness). It registers three slots:
 *
 *   1. `settings.section` (root scope, id "magic-context") — a READ-ONLY card
 *      that mirrors the Magic Context status and points at the JSONC config
 *      file; no write controls (the JSONC file stays the single source of
 *      truth, so there is no dual-source drift).
 *   2. `conversation.session.header.actions` (session scope, id
 *      "magic-context-status") — a per-session button opening a status
 *      summary popover.
 *   3. `conversation.view` (session scope, id "magic-context", tab "Context")
 *      — a per-session tab showing the context-management diagnostics
 *      (occupancy bar + tags/compartments/outbox counts). The conversation
 *      skeleton auto-derives tabs from this slot's registrations.
 *
 * Client→Host channel: this package is a PERSISTENT bundle, so the dynamic-
 * package `host.call` primitive does not exist. The channel is the Typert
 * Gateway over the shared `/api` RPC transport (dsh-reference §F.4 / §G.1):
 * `connection.rpc.call('/api', 'magicContext/status' | 'magicContext/diagnostics',
 * { args: { args: request } })`, served by the host half (src/host/remote.ts).
 * The descriptor declares one parameter with wire "args", so the argument
 * object rides under payload.args.args — a bare `{ sessionId }` would fail
 * the gateway's assertExactArguments. Every failure degrades to a visible
 * "endpoint unavailable" row instead of breaking the UI.
 *
 * Styling follows the official bundles: DSW alias tokens for colors/type and
 * a self-injected `<style data-plugin-css>` block (the pattern of
 * dsh-client-ui-jobs).
 *
 * Type safety: slot contracts come from the @deepseek-ai/dsh-client-ui-*
 * SlotMap augmentations; the status/diagnostics wire shapes are mirrored
 * locally (never imported from src/host — the browser bundle must not drag
 * node host code with it).
 */

import { useEffect, useRef, useState } from "react";
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
import type { SnapshotSelectorHook } from "@deepseek-ai/dsh-client-ui-slots";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Context } from "@deepseek-ai/cordis";

/* -------------------------------------------- ui-conversation / ui-settings slot augmentations */
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";

/* ------------------------------------------------ styles */
const CSS_TAG_ID = "dsh-magic-context/status.css";
const css = [
  ".ckmc-root{position:relative}",
  ".ckmc-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex}",
  ".ckmc-trigger:hover,.ckmc-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}",
  ".ckmc-triggerOpen{transform:rotate(180deg)}",
  ".ckmc-menu{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);width:min(420px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 140px));box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:10px;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}",
  ".ckmc-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px;min-width:0}",
  ".ckmc-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:600;margin:0 0 4px}",
  ".ckmc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}",
  ".ckmc-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px;border-top:1px solid var(--dsw-alias-border-l2);padding:4px 0;min-width:0}",
  ".ckmc-row:first-of-type{border-top:0}",
  ".ckmc-label{color:var(--dsw-alias-label-tertiary);flex:none}",
  ".ckmc-value{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".ckmc-valueOk{color:var(--dsw-alias-state-success-primary)}",
  ".ckmc-valueErr{color:var(--dsw-alias-label-error)}",
  ".ckmc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:8px 0 0}",
  ".ckmc-btn{min-height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:16px;padding:2px 8px}",
  ".ckmc-btn:hover{color:var(--dsw-alias-label-primary)}",
  ".ckmc-actions{display:flex;gap:8px;align-items:center;margin-top:8px}",
  ".ckmc-loading{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
  // Context tab extras.
  ".ckmc-barRow{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px}",
  ".ckmc-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;margin:2px 0 6px}",
  ".ckmc-barFill{height:100%;border-radius:3px;background:var(--dsw-alias-state-success-primary);transition:width .2s ease}",
  ".ckmc-rows{border-top:1px solid var(--dsw-alias-border-l2);margin-top:6px}",
].join("");
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-magic-context";
  tag.dataset.pluginCss = CSS_TAG_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}
const C = {
  root: "ckmc-root",
  trigger: "ckmc-trigger",
  triggerOpen: "ckmc-triggerOpen",
  menu: "ckmc-menu",
  card: "ckmc-card",
  title: "ckmc-title",
  desc: "ckmc-desc",
  row: "ckmc-row",
  label: "ckmc-label",
  value: "ckmc-value",
  valueOk: "ckmc-valueOk",
  valueErr: "ckmc-valueErr",
  hint: "ckmc-hint",
  btn: "ckmc-btn",
  actions: "ckmc-actions",
  loading: "ckmc-loading",
  barRow: "ckmc-barRow",
  bar: "ckmc-bar",
  barFill: "ckmc-barFill",
  rows: "ckmc-rows",
} as const;

/* ----------------------------------------- wire types (mirror of src/host/remote.ts) */
/** Host `magicContext/status` payload. Keep in sync with src/host/remote.ts. */
export interface MagicStatus {
  readonly package: string;
  readonly harness: "dsh";
  readonly storage: {
    readonly ok: boolean;
    readonly schemaVersion?: number;
    readonly latestSupported: number;
    readonly reason?: string;
    readonly detail?: string;
  };
  readonly config: { readonly path: string; readonly exists: boolean };
  readonly preset: { readonly dir: string; readonly exists: boolean };
  readonly sessionId?: string | null;
}

/** Host `magicContext/diagnostics` payload. Keep in sync with src/host/remote.ts. */
export interface MagicSessionDiagnostics {
  readonly sessionId: string;
  readonly outbox: {
    readonly pending: number;
    readonly applied: number;
    readonly committed: number;
    readonly abandoned: number;
  };
  readonly tags: { readonly active: number; readonly dropped: number };
  readonly compartments: number;
  readonly meta: { readonly lastContextPercentage?: number; readonly hasM0: boolean };
}

/** Error branch of the gateway RPC result (structural subset of dsh-host-apiproxy). */
export interface MagicRpcError {
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
}

/** Business success/failure result of one unary RPC call; methods never throw business errors. */
export type MagicRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MagicRpcError };

/** Minimal structural face of the browser `connection` service this bundle needs. */
export interface RpcConnectionLike {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<MagicRpcResult<unknown>>;
  };
}

/* ------------------------------------- host communication */
const CHANNEL = "/api";
const STATUS_ENDPOINT = "magicContext/status";
const DIAGNOSTICS_ENDPOINT = "magicContext/diagnostics";

function unavailable(message: string): MagicRpcResult<never> {
  return { ok: false, error: { code: "unavailable", message, details: {} } };
}

function transportError(error: unknown): MagicRpcResult<never> {
  const message = error instanceof Error && error.message !== undefined ? error.message : String(error);
  return { ok: false, error: { code: "transport", message, details: {} } };
}

/**
 * Call one Typert Gateway endpoint through the persistent bundle's channel
 * (connection.rpc over the shared /api transport). Never throws: transport or
 * wiring failures collapse into an ok:false result so the UI can render an
 * "endpoint unavailable" row.
 */
function callRpc<T>(
  connection: RpcConnectionLike | undefined,
  endpoint: string,
  request: unknown,
): Promise<MagicRpcResult<T>> {
  if (typeof connection?.rpc?.call !== "function") {
    return Promise.resolve(unavailable("connection.rpc is unavailable on this page"));
  }
  // Wire shape: the gateway expects payload = { args: { <wire>: value } }.
  // The descriptor declares one parameter with wire "args", so the argument
  // object rides under payload.args.args — a bare { sessionId } would fail
  // the gateway's assertExactArguments.
  return connection.rpc.call(CHANNEL, endpoint, { args: { args: request } }).then(
    (result) => {
      if (result !== null && typeof result === "object" && result.ok === true) {
        return { ok: true as const, value: result.value as T };
      }
      return result as MagicRpcResult<T>;
    },
    (error: unknown) => transportError(error),
  );
}

/** Call the host `magicContext/status` Remote (session optional). */
export function callStatus(
  connection: RpcConnectionLike | undefined,
  args: { sessionId?: string } = {},
): Promise<MagicRpcResult<MagicStatus>> {
  return callRpc<MagicStatus>(connection, STATUS_ENDPOINT, args);
}

/** Call the host `magicContext/diagnostics` Remote for one session. */
export function callDiagnostics(
  connection: RpcConnectionLike | undefined,
  args: { sessionId: string },
): Promise<MagicRpcResult<MagicSessionDiagnostics>> {
  return callRpc<MagicSessionDiagnostics>(connection, DIAGNOSTICS_ENDPOINT, args);
}

/* ------------------------------------------------ controllers */
export interface StatusSnapshotState {
  readonly state: "idle" | "loading" | "ready" | "error";
  readonly status: MagicStatus | null;
  readonly error: MagicRpcError | null;
}

export interface DiagnosticsSnapshotState {
  readonly state: "idle" | "loading" | "ready" | "error";
  readonly diagnostics: MagicSessionDiagnostics | null;
  readonly error: MagicRpcError | null;
}

/**
 * Tiny per-slot snapshot-store controller fed by one host call. The store is
 * exposed through the slot inject face as a use<Name> selector hook; refresh
 * re-pulls the endpoint for whatever args the caller passes.
 */
class StatusController {
  readonly store: SnapshotStore<StatusSnapshotState>;

  constructor(connection: RpcConnectionLike | undefined) {
    this.store = createSnapshotStore<StatusSnapshotState>({ state: "idle", status: null, error: null });
    this.refresh = (args?: { sessionId?: string }) => {
      const request = args === undefined ? {} : args;
      this.store.set({ state: "loading", status: null, error: null });
      return callStatus(connection, request).then((result) => {
        this.store.set(
          result.ok === true
            ? { state: "ready", status: result.value, error: null }
            : { state: "error", status: null, error: result.error },
        );
      });
    };
  }

  /** Re-pull the status for an optional session. */
  readonly refresh: (args?: { sessionId?: string }) => Promise<void>;
}

/**
 * Same shape as StatusController but for `magicContext/diagnostics`. One
 * controller per slot (existing headerController pattern): the view refreshes
 * with whichever session is current when it mounts / is asked to.
 */
class DiagnosticsController {
  readonly store: SnapshotStore<DiagnosticsSnapshotState>;

  constructor(connection: RpcConnectionLike | undefined) {
    this.store = createSnapshotStore<DiagnosticsSnapshotState>({ state: "idle", diagnostics: null, error: null });
    this.refresh = (args: { sessionId: string }) => {
      this.store.set({ state: "loading", diagnostics: null, error: null });
      return callDiagnostics(connection, args).then((result) => {
        this.store.set(
          result.ok === true
            ? { state: "ready", diagnostics: result.value, error: null }
            : { state: "error", diagnostics: null, error: result.error },
        );
      });
    };
  }

  /** Re-pull the diagnostics for one session. */
  readonly refresh: (args: { sessionId: string }) => Promise<void>;
}

/* ------------------------------------------------ rows */
function storageText(status: MagicStatus): string {
  if (status.storage === undefined || status.storage === null) return "unknown";
  if (status.storage.ok === true) {
    return `ok · schema v${status.storage.schemaVersion}/${status.storage.latestSupported}`;
  }
  const reason = status.storage.reason !== undefined ? status.storage.reason : "error";
  return reason + (status.storage.detail !== undefined && status.storage.detail !== "" ? ` · ${status.storage.detail}` : "");
}

type RowTone = "ok" | "err" | "plain";

interface RowSpec {
  readonly label: string;
  readonly value: string;
  readonly tone?: RowTone;
}

/** One label/value row, tone-colored value; plain rows keep the neutral mono text. */
function Row({ label, value, tone = "plain" }: RowSpec) {
  const cls = tone === "plain" ? C.value : tone === "ok" ? `${C.value} ${C.valueOk}` : `${C.value} ${C.valueErr}`;
  return (
    <div className={C.row}>
      <span className={C.label}>{label}</span>
      <span className={cls} title={value}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------ status rows */
function summaryRows(status: MagicStatus): RowSpec[] {
  return [
    { label: "harness", value: "dsh", tone: "ok" },
    { label: "storage", value: storageText(status), tone: status.storage && status.storage.ok ? "ok" : "err" },
    { label: "config", value: status.config && status.config.exists ? "present" : "missing", tone: status.config && status.config.exists ? "ok" : "err" },
    { label: "preset", value: status.preset && status.preset.exists ? "generated" : "missing", tone: status.preset && status.preset.exists ? "ok" : "err" },
    { label: "session", value: status.sessionId !== undefined && status.sessionId !== null ? status.sessionId : "—" },
  ];
}

/** Shared status body: loading → rows / error, with a refresh button. */
export interface StatusSummaryProps {
  useMagicStatus: SnapshotSelectorHook<StatusSnapshotState>;
  onRefresh: () => void;
  onClose?: () => void;
}

export function StatusSummary({ useMagicStatus, onRefresh, onClose }: StatusSummaryProps) {
  const snapshot = useMagicStatus((state) => state);
  const rows = snapshot.status === null ? [] : summaryRows(snapshot.status);
  return (
    <div className={C.card}>
      <h3 className={C.title}>Magic Context 状态</h3>
      <p className={C.desc}>dsh-magic-context · DSH 适配器</p>
      {snapshot.state === "loading" && <p className={C.loading}>读取状态…</p>}
      {snapshot.state === "error" && rows.length === 0 && (
        <p className={C.loading}>
          主机端点不可用：{snapshot.error && snapshot.error.message !== undefined ? snapshot.error.message : "unknown"}（需要 host
          半侧注册 magicContext/status）
        </p>
      )}
      {snapshot.state === "ready" && snapshot.status !== null && (
        <div>
          {rows.map((row) => (
            <Row key={row.label} {...row} />
          ))}
        </div>
      )}
      <p className={C.hint}>配置源：~/.config/cortexkit/magic-context.jsonc —— 此界面只读，请用编辑器修改。</p>
      <div className={C.actions}>
        <button type="button" className={C.btn} disabled={snapshot.state === "loading"} onClick={onRefresh}>
          刷新
        </button>
        {onClose !== undefined && (
          <button type="button" className={C.btn} onClick={onClose}>
            关闭
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- settings.section entry */
/** Read-only settings section mirroring live status and the config location. */
export interface MagicSettingsSectionProps {
  useMagicStatus: SnapshotSelectorHook<StatusSnapshotState>;
  refresh: (args?: { sessionId?: string }) => void;
}

export function MagicSettingsSection({ useMagicStatus, refresh }: MagicSettingsSectionProps) {
  return (
    <div className={C.root}>
      <StatusSummary useMagicStatus={useMagicStatus} onRefresh={() => refresh({})} />
    </div>
  );
}

/* -------------------- header action entry (session) */
export interface MagicHeaderActionProps {
  useMagicStatus: SnapshotSelectorHook<StatusSnapshotState>;
  refresh: (args?: { sessionId?: string }) => void;
  sessionId: string;
}

export function MagicHeaderAction({ useMagicStatus, refresh, sessionId }: MagicHeaderActionProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (!openedRef.current) {
      openedRef.current = true;
      refresh({ sessionId });
    }
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, sessionId, refresh]);
  return (
    <div ref={rootRef} className={C.root}>
      <button
        ref={triggerRef}
        type="button"
        className={C.trigger}
        aria-expanded={open ? "true" : "false"}
        aria-label="Magic Context 状态"
        title="Magic Context 状态"
        onClick={() => setOpen(!open)}
      >
        <span>MC</span>
        <IconChevronDownOutline14 className={open ? C.triggerOpen : undefined} />
      </button>
      {open && (
        <div className={C.menu}>
          <StatusSummary useMagicStatus={useMagicStatus} onRefresh={() => refresh({ sessionId })} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/* -------------------------------- conversation.view entry */
/** Session-scope view props: standard kit (sessionId) + injected diagnostics face. */
export interface ContextTabViewProps {
  useMagicDiagnostics: SnapshotSelectorHook<DiagnosticsSnapshotState>;
  refresh: (args: { sessionId: string }) => void;
  sessionId: string;
}

/** Clamp the host-reported occupancy into a legal bar width. */
function occupancyWidth(percentage: number): string {
  return `${Math.max(0, Math.min(100, percentage))}%`;
}

/**
 * "Context" tab: reads `magicContext/diagnostics` for the current session and
 * shows occupancy (primary, as a bar) plus outbox/tags/compartments counts.
 * Refresh = first open + the manual button (no polling, Q4 scope).
 */
export function ContextTabView({ useMagicDiagnostics, refresh, sessionId }: ContextTabViewProps) {
  const snapshot = useMagicDiagnostics((state) => state);
  useEffect(() => {
    refresh({ sessionId });
  }, [sessionId, refresh]);
  const diagnostics = snapshot.diagnostics;
  const lastPct = diagnostics?.meta.lastContextPercentage;
  return (
    <div className={C.card}>
      <h3 className={C.title}>Magic Context · 上下文</h3>
      <p className={C.desc}>dsh-magic-context · DSH 适配器</p>
      {snapshot.state === "loading" && <p className={C.loading}>读取状态…</p>}
      {snapshot.state === "error" && (
        <p className={C.loading}>
          主机端点不可用：{snapshot.error && snapshot.error.message !== undefined ? snapshot.error.message : "unknown"}（需要 host
          半侧注册 magicContext/diagnostics）
        </p>
      )}
      {snapshot.state === "ready" && diagnostics !== null && (
        <>
          <div className={C.barRow}>
            <span className={C.label}>上下文占比</span>
            <span className={C.value}>{lastPct !== undefined ? `${lastPct}%` : "未知"}</span>
          </div>
          {lastPct !== undefined && (
            <div className={C.bar} role="progressbar" aria-valuenow={Math.round(lastPct)} aria-valuemin={0} aria-valuemax={100}>
              <div className={C.barFill} style={{ width: occupancyWidth(lastPct) }} />
            </div>
          )}
          <div className={C.rows}>
            <Row label="活跃标签" value={String(diagnostics.tags.active)} />
            <Row label="已丢标签" value={String(diagnostics.tags.dropped)} />
            <Row label="Compartment" value={String(diagnostics.compartments)} />
            <Row label="待处理" value={String(diagnostics.outbox.pending)} />
            <Row label="已应用" value={String(diagnostics.outbox.applied)} />
            <Row label="已提交" value={String(diagnostics.outbox.committed)} />
            <Row label="已放弃" value={String(diagnostics.outbox.abandoned)} />
          </div>
        </>
      )}
      <div className={C.actions}>
        <button type="button" className={C.btn} disabled={snapshot.state === "loading"} onClick={() => refresh({ sessionId })}>
          刷新
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------ mount */
export function apply(ctx: Context): void {
  const connection = ctx.get("connection") as RpcConnectionLike | undefined;
  // One controller per slot: the settings section is root-scoped (refreshes
  // with no session) while the header action and the Context view are
  // session-scoped — sharing one store would let the last session leak across
  // surfaces. The view keeps the plugin-level controller (headerController
  // pattern), refreshing with whichever session is current on open.
  const sectionController = new StatusController(connection);
  const headerController = new StatusController(connection);
  const diagnosticsController = new DiagnosticsController(connection);

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({
      name: "settings.section",
      id: "magic-context",
      order: 60,
      label: "Magic Context",
      inject: () => ({
        hooks: { magicStatus: sectionController.store },
        refresh: sectionController.refresh,
      }),
    }, MagicSettingsSection),
  );

  ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "magic-context-status",
      order: 40,
      label: "Magic Context 状态",
      inject: () => ({
        hooks: { magicStatus: headerController.store },
        refresh: headerController.refresh,
      }),
    }, MagicHeaderAction),
  );

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register({
      name: "conversation.view",
      id: "magic-context",
      order: 20,
      label: "Context",
      inject: (sessionId) => ({
        hooks: { magicDiagnostics: diagnosticsController.store },
        refresh: (args?: { sessionId?: string }) => diagnosticsController.refresh({ sessionId: args?.sessionId ?? sessionId }),
      }),
    }, ContextTabView),
  );
}

export const name = "dsh-magic-context";
export const inject = ["slots", "connection"];