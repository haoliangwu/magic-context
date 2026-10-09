import { createResource, createSignal, For, Show } from "solid-js";
import {
  deleteUserMemory,
  deleteUserMemoryCandidate,
  dismissUserMemory,
  formatRelativeTime,
  getUserMemories,
  getUserMemoryCandidates,
  promoteUserMemoryCandidate,
  updateUserMemoryContent,
} from "../../lib/api";
import FilterSelect from "../shared/FilterSelect";

export default function UserMemories() {
  const [statusFilter, setStatusFilter] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);
  const [editingId, setEditingId] = createSignal<number | null>(null);
  const [editContent, setEditContent] = createSignal<string>("");
  // Two-click delete confirm (mirrors MemoryDetail): first click arms the
  // confirm for that row's key; a second click within 3s performs the delete.
  const [confirmDeleteKey, setConfirmDeleteKey] = createSignal<string | null>(null);
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | undefined;

  const confirmDelete = (key: string, perform: () => void) => {
    if (confirmDeleteKey() !== key) {
      setConfirmDeleteKey(key);
      if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
      confirmDeleteTimer = setTimeout(() => setConfirmDeleteKey(null), 3000);
      return;
    }
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    setConfirmDeleteKey(null);
    perform();
  };

  const startEdit = (id: number, content: string) => {
    setEditContent(content);
    setEditingId(id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent("");
  };

  const handleSaveEdit = async (id: number) => {
    const next = editContent().trim();
    if (next.length === 0) {
      setError("Memory content cannot be empty.");
      return;
    }
    try {
      setError(null);
      await updateUserMemoryContent(id, next);
      cancelEdit();
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to update memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const fetchMemories = () => ({ status: statusFilter() || undefined });
  const [memories, { refetch: refetchMemories }] = createResource(fetchMemories, (params) =>
    getUserMemories(params.status),
  );

  const [candidates, { refetch: refetchCandidates }] = createResource(getUserMemoryCandidates);

  const activeMemories = () => (memories() ?? []).filter((m) => m.status === "active");
  const dismissedMemories = () => (memories() ?? []).filter((m) => m.status === "dismissed");

  const handleDismiss = async (id: number) => {
    try {
      setError(null);
      await dismissUserMemory(id);
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to dismiss memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteMemory = async (id: number) => {
    try {
      setError(null);
      await deleteUserMemory(id);
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to delete memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteCandidate = async (id: number) => {
    try {
      setError(null);
      await deleteUserMemoryCandidate(id);
      refetchCandidates();
    } catch (e: unknown) {
      setError(`Failed to delete candidate: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handlePromoteCandidate = async (id: number) => {
    try {
      setError(null);
      await promoteUserMemoryCandidate(id);
      refetchCandidates();
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to promote candidate: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusPillClass = (status: string) => {
    switch (status) {
      case "active":
        return "green";
      case "dismissed":
        return "gray";
      default:
        return "gray";
    }
  };

  const truncateSessionId = (sessionId: string) => {
    if (sessionId.length <= 12) return sessionId;
    return `${sessionId.slice(0, 8)}…`;
  };

  return (
    <>
      {/* Error toast */}
      <Show when={error()}>
        <div style={{ padding: "8px 20px" }}>
          <div
            style={{
              background: "var(--error-bg)",
              border: "1px solid var(--error-border)",
              "border-radius": "var(--radius-md)",
              padding: "8px 12px",
              "font-size": "12px",
              color: "var(--error-text)",
              display: "flex",
              "justify-content": "space-between",
              "align-items": "center",
            }}
          >
            <span>{error()}</span>
            <button
              type="button"
              class="btn sm"
              onClick={() => setError(null)}
              style={{ "min-width": "auto", padding: "2px 8px" }}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>

      <div class="section-header">
        <h1 class="section-title">User Memories</h1>
        <div class="section-actions">
          <Show when={memories()}>
            <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              {activeMemories().length} active · {dismissedMemories().length} dismissed
            </span>
          </Show>
        </div>
      </div>

      <div class="filter-bar">
        <FilterSelect
          value={statusFilter()}
          onChange={setStatusFilter}
          placeholder="All status"
          align="left"
          options={[
            { value: "", label: "All status" },
            { value: "active", label: "Active" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
      </div>

      <div class="scroll-area">
        {/* Stable User Memories Section */}
        <div class="list-gap" style={{ "margin-bottom": "24px" }}>
          <div class="category-header">
            Stable User Memories
            <span class="category-count">
              ({activeMemories().length + dismissedMemories().length})
            </span>
          </div>

          <Show
            when={!memories.loading}
            fallback={<div class="empty-state">Loading memories...</div>}
          >
            <Show
              when={(memories() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">👤</span>
                  <span>No user memories found</span>
                </div>
              }
            >
              <For each={memories()}>
                {(memory) => (
                  <div class="card">
                    <Show
                      when={editingId() === memory.id}
                      fallback={
                        <div class="card-title" style={{ "white-space": "pre-wrap" }}>
                          <span
                            class="mono"
                            style={{
                              color: "var(--text-muted)",
                              "margin-right": "6px",
                            }}
                          >
                            #{memory.id}
                          </span>
                          {memory.content}
                        </div>
                      }
                    >
                      <textarea
                        class="code-editor"
                        style={{ "min-height": "80px", width: "100%" }}
                        value={editContent()}
                        onInput={(e) => setEditContent(e.currentTarget.value)}
                      />
                    </Show>
                    <div class="card-meta">
                      <span class={`pill ${statusPillClass(memory.status)}`}>{memory.status}</span>
                      <Show when={memory.promoted_at}>
                        {(t) => <span>promoted {formatRelativeTime(t())}</span>}
                      </Show>
                      <Show
                        when={memory.source_candidate_ids && memory.source_candidate_ids.length > 0}
                      >
                        <span style={{ color: "var(--text-muted)" }}>
                          from candidates: {memory.source_candidate_ids?.join(", ")}
                        </span>
                      </Show>
                      <span>{formatRelativeTime(memory.created_at)}</span>
                    </div>
                    <div
                      class="card-actions"
                      style={{
                        display: "flex",
                        gap: "8px",
                        "margin-top": "8px",
                      }}
                    >
                      <Show
                        when={editingId() === memory.id}
                        fallback={
                          <>
                            <button
                              type="button"
                              class="btn sm"
                              onClick={() => startEdit(memory.id, memory.content)}
                            >
                              Edit
                            </button>
                            <Show when={memory.status === "active"}>
                              <button
                                type="button"
                                class="btn sm"
                                onClick={() => handleDismiss(memory.id)}
                              >
                                Dismiss
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="btn sm danger"
                              onClick={() =>
                                confirmDelete(`mem:${memory.id}`, () =>
                                  handleDeleteMemory(memory.id),
                                )
                              }
                            >
                              {confirmDeleteKey() === `mem:${memory.id}` ? "Confirm?" : "Delete"}
                            </button>
                          </>
                        }
                      >
                        <button
                          type="button"
                          class="btn sm primary"
                          onClick={() => handleSaveEdit(memory.id)}
                        >
                          Save
                        </button>
                        <button type="button" class="btn sm" onClick={cancelEdit}>
                          Cancel
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>

        {/* Candidates Section */}
        <div class="list-gap">
          <div class="category-header">
            Candidates
            <span class="category-count">({(candidates() ?? []).length})</span>
          </div>

          <Show
            when={!candidates.loading}
            fallback={<div class="empty-state">Loading candidates...</div>}
          >
            <Show
              when={(candidates() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">📝</span>
                  <span>No pending candidates</span>
                </div>
              }
            >
              <For each={candidates()}>
                {(candidate) => (
                  <div class="card">
                    <div class="card-title" style={{ "white-space": "pre-wrap" }}>
                      <span
                        class="mono"
                        style={{
                          color: "var(--text-muted)",
                          "margin-right": "6px",
                        }}
                      >
                        #{candidate.id}
                      </span>
                      {candidate.content}
                    </div>
                    <div class="card-meta">
                      <span class="pill blue">candidate</span>
                      <span title={candidate.session_id}>
                        session: {truncateSessionId(candidate.session_id)}
                      </span>
                      <Show
                        when={
                          candidate.source_compartment_start && candidate.source_compartment_end
                        }
                      >
                        <span style={{ color: "var(--text-muted)" }}>
                          compartments: {candidate.source_compartment_start}–
                          {candidate.source_compartment_end}
                        </span>
                      </Show>
                      <span>{formatRelativeTime(candidate.created_at)}</span>
                    </div>
                    <div
                      class="card-actions"
                      style={{
                        display: "flex",
                        gap: "8px",
                        "margin-top": "8px",
                      }}
                    >
                      <button
                        type="button"
                        class="btn sm"
                        onClick={() => handlePromoteCandidate(candidate.id)}
                      >
                        Promote
                      </button>
                      <button
                        type="button"
                        class="btn sm danger"
                        onClick={() =>
                          confirmDelete(`cand:${candidate.id}`, () =>
                            handleDeleteCandidate(candidate.id),
                          )
                        }
                      >
                        {confirmDeleteKey() === `cand:${candidate.id}` ? "Confirm?" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </>
  );
}
