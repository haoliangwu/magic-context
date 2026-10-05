/**
 * The directory whose Magic Context server owns a session.
 *
 * OpenCode starts one Magic Context server instance per directory. The TUI
 * starts in one directory but can show a session from another one (non-git
 * directories share OpenCode's global project, so a TUI started in the home
 * directory lists sessions from any of them). The sidebar and `/ctx-status`
 * must ask the server for the session's directory, not the startup one.
 *
 * `sessionDirectory` is what the host reports for the session (OpenCode 1:
 * `api.state.session.get(id).directory`; OpenCode 2:
 * `context.data.session.get(id).location.directory`). The startup directory is
 * the fallback while the host has not loaded the session yet.
 */
export function directoryForSession(sessionDirectory: unknown, startupDirectory: string): string {
    return typeof sessionDirectory === "string" && sessionDirectory.length > 0
        ? sessionDirectory
        : startupDirectory;
}
