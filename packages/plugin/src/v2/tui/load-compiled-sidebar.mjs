// Loads the precompiled OpenCode 1 sidebar for the OpenCode 2 slot mount.
//
// This lives in a .mjs file on purpose. `src/tui-compiled/slots/sidebar-content.tsx`
// is Solid-transform output that the package never typechecks or compiles — it
// is shipped verbatim and executed by the host — and a TypeScript file importing
// a .tsx path forces `--jsx` on the whole program, which would pull that
// generated file into the type graph. Keeping the import here is the same
// arrangement `src/tui/entry.mjs` already uses for the v1 entry; the typed view
// of this module is the sibling load-compiled-sidebar.d.mts.
//
// Explicit extensions match entry.mjs: the host resolves these paths directly,
// with no bundler step to fill an extension in.

/**
 * Imports the compiled sidebar component and the RPC data-layer copy that
 * compiled tree carries. Rejects when the host registers no
 * `opentui:runtime-module:*` virtual modules to resolve the component's runtime
 * imports through; the caller answers that case with the text projection.
 */
export async function loadCompiledSidebar() {
    const component = await import("../../tui-compiled/slots/sidebar-content.tsx");
    const data = await import("../../tui-compiled/data/context-db.ts");
    return { component, data };
}
