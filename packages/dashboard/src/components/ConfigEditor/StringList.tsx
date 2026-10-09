import { createSignal, Index } from "solid-js";

export default function StringList(props: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = createSignal("");
  return (
    <div class="config-list-editor">
      <Index each={props.value}>
        {(entry, index) => (
          <div class="config-list-row">
            <input
              class="config-input"
              aria-label={`${props.label} entry ${index + 1}`}
              value={entry()}
              onInput={(event) =>
                props.onChange(
                  props.value.map((value, i) => (i === index ? event.currentTarget.value : value)),
                )
              }
            />
            <button
              type="button"
              class="config-icon-btn"
              aria-label={`Remove extension ${index + 1}`}
              onClick={() => props.onChange(props.value.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        )}
      </Index>
      <form
        class="config-list-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft().trim()) {
            props.onChange([...props.value, draft().trim()]);
            setDraft("");
          }
        }}
      >
        <input
          class="config-input"
          aria-label="New Pi subagent extension"
          placeholder="Extension path or package"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" class="btn sm" disabled={!draft().trim()}>
          + Add
        </button>
      </form>
    </div>
  );
}
