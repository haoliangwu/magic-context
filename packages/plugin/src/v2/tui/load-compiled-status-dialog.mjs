// Loads the precompiled OpenCode 1 status dialog for the OpenCode 2 dialog surface.
//
// Same arrangement, and same reasons, as load-compiled-sidebar.mjs next to it:
// `src/tui-compiled/dialogs/status-dialog.tsx` is Solid-transform output that this
// package never typechecks or compiles, and a TypeScript file importing a .tsx
// path would force `--jsx` on the whole program and pull that generated file into
// the type graph. The typed view of this module is load-compiled-status-dialog.d.mts.

/**
 * Imports the compiled status dialog component. Rejects when the host registers
 * no `opentui:runtime-module:*` virtual modules to resolve the component's
 * runtime imports through; the caller answers that case with the text dialog.
 */
export async function loadCompiledStatusDialog() {
    return await import("../../tui-compiled/dialogs/status-dialog.tsx");
}
