import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export function canonicalStoragePath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

export function textReferencesStorage(text: string, storageDir: string): boolean {
    const target = canonicalStoragePath(storageDir);
    // ps includes environment assignments after argv; /proc separates them with NUL.
    // Compare complete values, not substrings that also match a sibling directory.
    const tokens = text.match(/(?:[^\s\0"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const token of tokens) {
        const value = token.replace(/^[^=]+=|^["']|["']$/g, "").replace(/^["']|["']$/g, "");
        if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) continue;
        if (canonicalStoragePath(value) === target) return true;
        if (
            token.startsWith("XDG_DATA_HOME=") &&
            canonicalStoragePath(join(value, "cortexkit", "magic-context")) === target
        )
            return true;
    }
    return false;
}

/** Read process metadata only; never open the process's configured database or config. */
export function processReferencesStorage(pid: number, storageDir: string): boolean {
    const texts: string[] = [];
    if (process.platform === "linux") {
        for (const name of ["cmdline", "environ"]) {
            try {
                texts.push(readFileSync(`/proc/${pid}/${name}`, "utf8"));
            } catch {
                /* Not readable by this user. */
            }
        }
    } else {
        try {
            texts.push(
                process.platform === "win32"
                    ? execFileSync(
                          "powershell",
                          [
                              "-NoProfile",
                              "-Command",
                              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
                          ],
                          { encoding: "utf8", timeout: 15000, windowsHide: true },
                      )
                    : execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
                          encoding: "utf8",
                          timeout: 15000,
                          windowsHide: true,
                      }),
            );
        } catch {
            /* Unreadable metadata does not establish use of this non-default path. */
        }
    }
    return texts.some((text) => textReferencesStorage(text, storageDir));
}
