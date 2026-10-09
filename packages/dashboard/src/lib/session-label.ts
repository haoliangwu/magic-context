/**
 * How a session is named on screen. A session with a human title shows the
 * title; a background run whose name is only `<owner>:<kind>-<id>` (Broca runs
 * started by Alfonso, for instance) shows the kind of run as readable text,
 * the owner as a quiet label and the id as a quiet, copyable literal.
 */
export interface SessionLabel {
  /** Readable primary text, or null when the session has nothing but an id. */
  name: string | null;
  /** Who started the run (`alfonso` in `alfonso:bg_…`), when the name says. */
  owner: string | null;
  /** The literal id worth copying, shown in monospace. */
  id: string | null;
  /** Everything known about the name, for the tooltip. */
  tooltip: string;
}

// Run kinds recognised from the word that starts a background session's name.
// `bg_<hex>` is an Alfonso background task, which a Mason worker carries out.
const RUN_KINDS: Record<string, string> = {
  bg: "Mason task",
  consult: "Consult",
  sidekick: "Sidekick",
  oneshot: "One-shot",
  historian: "Historian",
  dreamer: "Dreamer",
};

// A consult or sidekick id is a UUID-like run of hex groups, sometimes followed
// by the role of that run within the larger job (`…-gather-a1`, `…-synthesis`).
const ID_WITH_ROLE = /^((?:[a-z]+_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-([a-z][\w-]*)$/i;

/**
 * Splits a run name like `alfonso:bg_c6f3cef176d331b2` into its readable parts.
 * Names that do not follow the `<owner>:<kind>-<id>` pattern are returned
 * whole as the primary text, so nothing is ever hidden or guessed at.
 */
export function runNameLabel(raw: string): SessionLabel {
  const colon = raw.indexOf(":");
  const owner = colon > 0 && !/\s/.test(raw.slice(0, colon)) ? raw.slice(0, colon) : null;
  const rest = owner ? raw.slice(colon + 1) : raw;
  const kind = /^([a-z]+)([-_])(.+)$/i.exec(rest);
  const kindLabel = kind ? RUN_KINDS[kind[1].toLowerCase()] : undefined;
  if (!kind || !kindLabel) return { name: raw, owner: null, id: null, tooltip: raw };
  // An Alfonso task id keeps its `bg_` prefix: that is the id people copy.
  let id = kind[2] === "_" ? rest : kind[3];
  let name = kindLabel;
  const role = ID_WITH_ROLE.exec(id);
  if (role) {
    id = role[1];
    name = `${kindLabel} · ${role[2]}`;
  }
  return { name, owner, id, tooltip: raw };
}

/**
 * The label for any harness's session: its title when it has a real one, the
 * parsed run name when the title is only a run name, else just its id.
 */
export function sessionLabel(
  harness: string,
  sessionId: string,
  title: string | null | undefined,
): SessionLabel {
  if (harness === "broca") {
    const name = brocaSessionName(sessionId) ?? title ?? sessionId;
    const label = runNameLabel(name);
    return { ...label, tooltip: brocaTooltip(sessionId, name) };
  }
  if (title) {
    return { name: title, owner: null, id: sessionId, tooltip: `${title}\n${sessionId}` };
  }
  return { name: null, owner: null, id: sessionId, tooltip: sessionId };
}

/** The `session` field of a Broca JSON identity, if the id is one. */
function brocaSessionName(sessionId: string): string | null {
  try {
    const identity = JSON.parse(sessionId) as { session?: unknown };
    return typeof identity.session === "string" ? identity.session : null;
  } catch {
    return null;
  }
}

function brocaTooltip(sessionId: string, name: string): string {
  try {
    const identity = JSON.parse(sessionId) as { project_root?: unknown; harness?: unknown };
    const lines = [name];
    if (typeof identity.harness === "string") lines.push(`harness: ${identity.harness}`);
    if (typeof identity.project_root === "string") lines.push(`project: ${identity.project_root}`);
    return lines.join("\n");
  } catch {
    return name;
  }
}
