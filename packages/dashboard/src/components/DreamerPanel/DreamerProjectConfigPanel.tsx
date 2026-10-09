import { createMemo, createResource, createSignal, Show } from "solid-js";

import { saveProjectConfig } from "../../lib/api";
import {
  jsoncErrorMessage,
  parseJsonc,
  patchDreamerTasksJsonc,
  removeDreamerBlockJsonc,
} from "../../lib/jsonc";
import { invoke } from "../../lib/platform";
import type { ConfigFile, DreamerProject } from "../../lib/types";
import { configSaveBlocker } from "../ConfigEditor/config-save-guard";
import DreamerTasksField, {
  type DreamTaskConfig,
  type DreamTaskModelConfig,
} from "../ConfigEditor/DreamerTasksField";
import type { Harness } from "../ConfigEditor/HarnessModelFields";

const hasOwn = (value: object, key: string | symbol) => Reflect.ownKeys(value).includes(key);

/**
 * Per-project dreamer config editor (the project-card gear).
 *
 * Option A storage: the project's own `magic-context.jsonc` file. We read the
 * file (or start empty), edit its shared schedules and selected harness task
 * entries, and write the whole file back via save_project_config — preserving every
 * other key. A project with a
 * `dreamer` block overrides the global config (the plugin deep-merges
 * project-over-user); removing the block reverts it to inheriting global.
 */
export default function DreamerProjectConfigPanel(props: {
  project: DreamerProject;
  opencodeModels: string[];
  piModels: string[];
  ompModels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const worktree = () => props.project.worktree ?? "";

  const [configFile] = createResource(
    () => worktree(),
    async (wt): Promise<ConfigFile> => invoke("get_config", { source: "project", projectPath: wt }),
  );

  // The full parsed config object (so we preserve unrelated keys on save), and
  // the editable dreamer.tasks slice. Read failures and malformed JSONC are
  // surfaced because patching an empty fallback would discard unrelated settings.
  const parsedConfig = createMemo(() => {
    const config = configFile();
    if (config?.exists && config.error) {
      return { value: {} as Record<string, unknown>, error: null as string | null };
    }
    try {
      return { value: parseJsonc(config?.content ?? ""), error: null as string | null };
    } catch (error) {
      return { value: {} as Record<string, unknown>, error: jsoncErrorMessage(error) };
    }
  });
  const parsed = () => parsedConfig().value;
  const parseError = () => parsedConfig().error;
  const saveBlocker = createMemo(() =>
    configSaveBlocker({
      exists: configFile()?.exists ?? false,
      readError: configFile()?.error,
      parseError: parseError(),
    }),
  );
  const dreamerObj = (): Record<string, unknown> => {
    const d = parsed().dreamer;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  };

  // Local working copy of tasks (seeded from file; edits accumulate here).
  const [tasks, setTasks] = createSignal<Record<string, DreamTaskConfig> | undefined>(undefined);
  const [harness, setHarness] = createSignal<Harness>("opencode");
  const [modelTaskOverrides, setModelTaskOverrides] = createSignal<
    Partial<Record<Harness, Record<string, DreamTaskModelConfig> | undefined>>
  >({});
  const effectiveTasks = (): Record<string, DreamTaskConfig> | undefined => {
    const local = tasks();
    if (local) return local;
    const stored = dreamerObj().tasks;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, DreamTaskConfig>)
      : undefined;
  };

  const effectiveModelTasks = (
    target: Harness,
  ): Record<string, DreamTaskModelConfig> | undefined => {
    const overrides = modelTaskOverrides();
    if (hasOwn(overrides, target)) return overrides[target];
    const block = dreamerObj()[target];
    if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
    const taskModels = (block as Record<string, unknown>).tasks;
    return taskModels && typeof taskModels === "object" && !Array.isArray(taskModels)
      ? (taskModels as Record<string, DreamTaskModelConfig>)
      : undefined;
  };

  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);

  const refuseBlockedSave = () => {
    const blocker = saveBlocker();
    if (!blocker) {
      return false;
    }
    setSaveStatus(`✕ ${blocker}`);
    setTimeout(() => setSaveStatus(null), 5000);
    return true;
  };

  const handleSave = async () => {
    const wt = worktree();
    if (!wt || refuseBlockedSave()) return;
    try {
      let nextConfig = patchDreamerTasksJsonc(configFile()?.content ?? "", effectiveTasks() ?? {});
      const overrides = modelTaskOverrides();
      for (const target of ["opencode", "pi", "omp"] as const) {
        if (hasOwn(overrides, target)) {
          nextConfig = patchDreamerTasksJsonc(
            nextConfig,
            effectiveTasks() ?? {},
            target,
            overrides[target],
          );
        }
      }
      await saveProjectConfig(wt, nextConfig);
      setSaveStatus("✓ Saved — applies on the next dreamer tick");
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${jsoncErrorMessage(err)}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const revertToInherited = async () => {
    const wt = worktree();
    if (!wt || refuseBlockedSave()) return;
    try {
      // Drop the dreamer block entirely → project inherits the global config.
      await saveProjectConfig(wt, removeDreamerBlockJsonc(configFile()?.content ?? ""));
      setSaveStatus("✓ Reverted to inherited global config");
      setTasks(undefined);
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${jsoncErrorMessage(err)}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  return (
    <div class="modal-overlay">
      <button type="button" class="modal-backdrop" aria-label="Close" onClick={props.onClose} />
      <div class="modal-card dreamer-config-modal">
        <div class="modal-header">
          <div class="modal-header-text">
            <div class="modal-title">{props.project.label}</div>
            <div class="card-meta mono">{props.project.config_path ?? worktree()}</div>
          </div>
          <button type="button" class="btn sm" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div class="modal-body">
          <Show when={!props.project.worktree}>
            <div class="empty-state" style={{ padding: "16px 0" }}>
              No resolvable directory for this project — per-project config can't be written. It
              inherits the global dreamer config.
            </div>
          </Show>

          <Show when={props.project.worktree}>
            <Show when={!configFile.loading} fallback={<div class="empty-state">Loading…</div>}>
              <p class="config-field-desc" style={{ "margin-bottom": "12px" }}>
                These settings override the global dreamer config for this project only, and are
                saved to the project's <code>magic-context.jsonc</code> (version-controllable — they
                travel to teammates' clones).
              </p>
              <Show when={saveBlocker()}>
                {(message) => (
                  <p
                    class="config-field-desc"
                    style={{ color: "var(--danger)", "margin-bottom": "12px" }}
                  >
                    {message()}
                  </p>
                )}
              </Show>
              <div class="tab-pills" style={{ "margin-bottom": "12px" }}>
                <button
                  type="button"
                  class={`tab-pill ${harness() === "opencode" ? "active" : ""}`}
                  onClick={() => setHarness("opencode")}
                >
                  OpenCode
                </button>
                <button
                  type="button"
                  class={`tab-pill ${harness() === "pi" ? "active" : ""}`}
                  onClick={() => setHarness("pi")}
                >
                  Pi
                </button>
                <button
                  type="button"
                  class={`tab-pill ${harness() === "omp" ? "active" : ""}`}
                  onClick={() => setHarness("omp")}
                >
                  OMP
                </button>
              </div>
              <DreamerTasksField
                value={effectiveTasks()}
                harness={harness()}
                modelTasks={effectiveModelTasks(harness())}
                onChange={(next) => {
                  setTasks(next);
                  setDirty(true);
                }}
                onModelTasksChange={(next) => {
                  setModelTaskOverrides((previous) => ({ ...previous, [harness()]: next }));
                  setDirty(true);
                }}
                models={
                  harness() === "opencode"
                    ? props.opencodeModels
                    : harness() === "omp"
                      ? props.ompModels
                      : props.piModels
                }
              />
            </Show>
          </Show>
        </div>

        <Show when={props.project.worktree && !configFile.loading}>
          <div class="modal-footer dreamer-config-actions">
            <button
              type="button"
              class="btn primary sm"
              disabled={!dirty() || Boolean(saveBlocker())}
              onClick={handleSave}
            >
              Save
            </button>
            <Show when={props.project.has_project_config}>
              <button
                type="button"
                class="btn sm"
                disabled={Boolean(saveBlocker())}
                onClick={revertToInherited}
              >
                Revert to inherited
              </button>
            </Show>
            <Show when={saveStatus()}>
              <span class="dreamer-config-status">{saveStatus()}</span>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
