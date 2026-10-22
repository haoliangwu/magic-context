/**
 * Accessible-state helpers for the Config page's custom controls.
 *
 * Several Config controls are plain buttons styled as segmented choices or as
 * pop-up pickers. Sighted users read their state from styling or from the
 * visible text, but for assistive technology (screen readers, macOS
 * accessibility clients) the choice is exposed through the control's role,
 * accessible name and ARIA state. These helpers compute
 * that state in one place so the components and the tests agree on it.
 */

/** Spoken in place of a value when a picker has nothing configured. */
export const NOT_SET_TEXT = "not set";

/**
 * Text a picker shows for its stored value: the matching option's label, or
 * the raw value when it is a custom entry not in the option list. Undefined
 * when nothing is stored, so callers fall back to their placeholder.
 */
export function pickerSelectedText(
  options: readonly { value: string; label: string }[],
  value: string | undefined,
): string | undefined {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Accessible name for a pop-up picker trigger.
 *
 * An `aria-label` replaces the button's visible text, so a label-only name
 * hides the current value and makes "blank" and "set" sound identical. The
 * name therefore carries both: "Primary variant: high", or
 * "Primary variant: not set (Use harness default)" when blank. The text in
 * parentheses is the placeholder sighted users see, which says what blank
 * means for that field.
 */
export function pickerAccessibleName(
  label: string,
  valueText: string | undefined,
  emptyText?: string,
): string {
  const value = valueText?.trim();
  if (value) return `${label}: ${value}`;
  return emptyText ? `${label}: ${NOT_SET_TEXT} (${emptyText})` : `${label}: ${NOT_SET_TEXT}`;
}

/** ARIA attributes for one option in a single-select radio group. */
export interface RadioOptionAttributes {
  role: "radio";
  "aria-checked": boolean;
  tabIndex: 0 | -1;
}

/**
 * Attributes for option `index` of a radio group whose current value is
 * `selected`. Only one option is in the Tab order (roving tabindex): the
 * checked one, or the first option when the stored value matches none of
 * them, so for a non-empty option list keyboard users can always reach the
 * group.
 */
export function radioOptionAttributes<T>(
  options: readonly T[],
  selected: T | undefined,
  index: number,
): RadioOptionAttributes {
  const checked = options[index] === selected;
  const anyChecked = options.includes(selected as T);
  const focusable = checked || (!anyChecked && index === 0);
  return { role: "radio", "aria-checked": checked, tabIndex: focusable ? 0 : -1 };
}

/**
 * Index the WAI-ARIA radio-group keyboard pattern moves to from `current`:
 * Right/Down go to the next option, Left/Up to the previous one (both wrap),
 * Home and End jump to the ends. Returns undefined for keys the group ignores.
 */
export function radioKeyTarget(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
