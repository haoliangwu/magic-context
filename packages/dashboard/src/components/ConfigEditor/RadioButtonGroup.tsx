import { For } from "solid-js";
import { radioKeyTarget, radioOptionAttributes } from "./a11y-state";

export interface RadioButtonOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Row of buttons that behaves as one single-select control. Visually it is the
 * same row of small buttons with the active one highlighted; to assistive
 * technology it is a radio group, so the active option is announced as checked.
 * Arrow keys, Home and End move the selection, following the WAI-ARIA radio
 * group pattern, and Tab enters and leaves the group as a single stop.
 */
export default function RadioButtonGroup<T extends string>(props: {
  label: string;
  options: readonly RadioButtonOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  let group!: HTMLDivElement;
  const values = () => props.options.map((option) => option.value);
  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const next = radioKeyTarget(event.key, index, props.options.length);
    if (next === undefined) return;
    event.preventDefault();
    props.onChange(props.options[next].value);
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={props.label}
      style={{ display: "flex", gap: "6px" }}
    >
      <For each={props.options}>
        {(option, index) => {
          const state = () => radioOptionAttributes(values(), props.value, index());
          return (
            // biome-ignore lint/a11y/useSemanticElements: A native radio input would need restyling to keep the existing button look; role="radio" on the button gives the same semantics with no visual change.
            <button
              type="button"
              class={`btn sm ${props.value === option.value ? "primary" : ""}`}
              role="radio"
              aria-checked={state()["aria-checked"]}
              tabIndex={state().tabIndex}
              onClick={() => props.onChange(option.value)}
              onKeyDown={(event) => handleKeyDown(event, index())}
            >
              {option.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
