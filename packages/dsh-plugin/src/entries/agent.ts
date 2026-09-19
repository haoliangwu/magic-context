/**
 * Subpath entry: `dsh-magic-context/agent` — the AGENT surface (PLAN §3.1
 * MagicContextAgentPlugin). Mounted as a HOST-plane row (`cordis.patch.yml`,
 * `inject: [magicContextHost]`): dsh's scope admission lets untagged host
 * listeners receive every agent's `agent/pre-step` events, so every preset's
 * sessions get Magic Context. All per-session state is keyed by canonical
 * session id (ADR 0001). The loader imports this module and activates the
 * returned Cordis plugin; every side effect is fiber-owned.
 */
import { apply, inject, name } from "../agent/index";
export { apply, inject, name };
export default { name, inject, apply };
