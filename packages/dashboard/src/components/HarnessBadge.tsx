import type { Harness } from "../lib/types";

interface HarnessBadgeProps {
  harness: Harness;
}

const HARNESS_LABELS: Record<Harness, { short: string; title: string; color: string }> = {
  opencode: { short: "OC", title: "OpenCode", color: "amber" },
  opencode2: { short: "OC2", title: "OpenCode 2", color: "amber" },
  pi: { short: "Pi", title: "Pi", color: "purple" },
  omp: { short: "OMP", title: "Oh My Pi", color: "purple" },
  claude_code: { short: "CC", title: "Claude Code", color: "blue" },
  codex: { short: "Codex", title: "Codex", color: "green" },
};

export default function HarnessBadge(props: HarnessBadgeProps) {
  const info = () => HARNESS_LABELS[props.harness];

  return (
    <span
      class={`pill ${info().color}`}
      title={info().title}
      style={{ "font-size": "9px", "line-height": "1.3", "text-transform": "uppercase" }}
    >
      {info().short}
    </span>
  );
}
