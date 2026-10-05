import { expect, test } from "bun:test";
import { directoryForSession } from "../../tui/data/session-directory";
import { sessionDirectory } from "./sidebar-mount";
import type { V2TuiContext } from "./types";

function contextWithSessions(
    sessions: Record<string, string> | undefined,
    throws = false,
): V2TuiContext {
    return {
        renderer: { requestRender() {} },
        data: {
            listen: () => () => {},
            location: { default: () => ({ directory: "/home/user" }) },
            ...(sessions === undefined
                ? {}
                : {
                      session: {
                          get: (sessionID: string) => {
                              if (throws) throw new Error("session store not ready");
                              const directory = sessions[sessionID];
                              return directory ? { location: { directory } } : undefined;
                          },
                      },
                  }),
        },
    } as unknown as V2TuiContext;
}

test("OpenCode 2 session calls use the session's own directory", () => {
    const context = contextWithSessions({ ses_project: "/home/user/Pictures/project" });
    expect(directoryForSession(sessionDirectory(context, "ses_project"), "/home/user")).toBe(
        "/home/user/Pictures/project",
    );
});

test("an unknown session, a host without session data, or a failing lookup use the startup directory", () => {
    expect(
        directoryForSession(sessionDirectory(contextWithSessions({}), "ses_x"), "/home/user"),
    ).toBe("/home/user");
    expect(
        directoryForSession(
            sessionDirectory(contextWithSessions(undefined), "ses_x"),
            "/home/user",
        ),
    ).toBe("/home/user");
    expect(
        directoryForSession(
            sessionDirectory(contextWithSessions({ ses_x: "/p" }, true), "ses_x"),
            "/home/user",
        ),
    ).toBe("/home/user");
});
