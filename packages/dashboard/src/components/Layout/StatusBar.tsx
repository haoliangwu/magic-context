import { Show } from "solid-js";
import { formatBytes } from "../../lib/api";
import type { DbHealth } from "../../lib/types";
import Icon from "../shared/Icon";

interface Props {
  health: DbHealth | undefined;
}

const COUNTED_TABLES: { table: string; label: string }[] = [
  { table: "memories", label: "memories" },
  { table: "compartments", label: "compartments" },
  { table: "session_facts", label: "facts" },
  { table: "notes", label: "notes" },
];

export default function StatusBar(props: Props) {
  const dbStatus = () => {
    if (!props.health) return { label: "Loading…", color: "amber" };
    if (!props.health.exists) return { label: "Database not found", color: "red" };
    return { label: "Database", color: "green" };
  };

  const count = (name: string) => {
    return props.health?.table_counts.find((t) => t.table_name === name)?.row_count ?? 0;
  };

  return (
    <footer class="status-bar">
      <div class="status-item" title={props.health?.exists ? props.health.path : undefined}>
        <span class={`status-dot ${dbStatus().color}`} />
        <Icon name="database" size={13} class="status-icon" />
        <span>{dbStatus().label}</span>
        <Show when={props.health?.exists && props.health}>
          {(health) => <span class="status-value">{formatBytes(health().size_bytes)}</span>}
        </Show>
      </div>
      <Show when={props.health?.exists}>
        {COUNTED_TABLES.map((entry) => (
          <div class="status-item">
            <span class="status-value">{count(entry.table).toLocaleString()}</span>
            <span>{entry.label}</span>
          </div>
        ))}
      </Show>
    </footer>
  );
}
