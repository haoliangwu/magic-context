import { describe, expect, it } from "bun:test";
import { runSqlitePreflight } from "./sqlite-preflight";

describe("SQLite doctor preflight", () => {
    it("reports remediation when the SQLite probe fails without throwing", async () => {
        const reports: string[] = [];
        const result = await runSqlitePreflight(
            async () => {
                throw new Error("No such built-in module: node:sqlite");
            },
            (message) => reports.push(message),
        );

        expect(result).toBe(false);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain("No such built-in module: node:sqlite");
        expect(reports[0]).toContain("install Node.js 22.16+ (22.x) or >= 24");
        expect(reports[0]).toContain("Bun build with node:sqlite");
        expect(reports[0]).toContain("node:24-slim");
        expect(reports[0]).toContain("two-runtime image");
    });

    it("allows doctor to continue when the SQLite probe succeeds", async () => {
        const reports: string[] = [];
        const result = await runSqlitePreflight(
            async () => {},
            (message) => reports.push(message),
        );

        expect(result).toBe(true);
        expect(reports).toEqual([]);
    });
});
