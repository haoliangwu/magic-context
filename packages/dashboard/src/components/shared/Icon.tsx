import type { JSX } from "solid-js";

/**
 * The dashboard's line icons: drawn inline on a 24×24 grid with a round 1.75px
 * stroke in the current text colour, so they follow the theme and the state of
 * the control they sit in (hover, active) without extra CSS.
 */
export type IconName =
  | "folder"
  | "layers"
  | "gauge"
  | "user"
  | "sliders"
  | "list"
  | "pause"
  | "play"
  | "chevron-right"
  | "chevron-down"
  | "database"
  | "arrow-up-circle"
  | "check";

// Factories, not shared elements: a Solid JSX element is a real DOM node, so
// one node reused by two icons would be moved rather than drawn twice.
const PATHS: Record<IconName, () => JSX.Element> = {
  folder: () => (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  ),
  layers: () => (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </>
  ),
  gauge: () => (
    <>
      <path d="M4 19.5V11" />
      <path d="M9.33 19.5V5" />
      <path d="M14.67 19.5v-6" />
      <path d="M20 19.5V8.5" />
    </>
  ),
  user: () => (
    <>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
    </>
  ),
  sliders: () => (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  list: () => (
    <>
      <path d="M9 6.5h11" />
      <path d="M9 12h11" />
      <path d="M9 17.5h11" />
      <path d="M4.5 6.5h.01" />
      <path d="M4.5 12h.01" />
      <path d="M4.5 17.5h.01" />
    </>
  ),
  pause: () => (
    <>
      <path d="M9 5.5v13" />
      <path d="M15 5.5v13" />
    </>
  ),
  play: () => <path d="M7.5 5.5v13l11-6.5z" />,
  "chevron-right": () => <path d="m9.5 6 6 6-6 6" />,
  "chevron-down": () => <path d="m6 9.5 6 6 6-6" />,
  database: () => (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.75" />
      <path d="M5 6v12c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75V6" />
      <path d="M5 12c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75" />
    </>
  ),
  "arrow-up-circle": () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 11.5 3.5-3.5 3.5 3.5" />
      <path d="M12 8v8" />
    </>
  ),
  check: () => <path d="m5.5 12.5 4 4 9-9" />,
};

export default function Icon(props: { name: IconName; size?: number; class?: string }) {
  const size = () => props.size ?? 16;
  return (
    <svg
      class={`icon ${props.class ?? ""}`}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]()}
    </svg>
  );
}
