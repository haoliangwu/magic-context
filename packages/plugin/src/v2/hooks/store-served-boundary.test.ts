/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { isHostUnservedRow } from "../../hooks/magic-context/host-served-rows";
import type { StoreRow } from "../store-reader";
import { hostServesRowById, rawMessages, servedBoundaryRow } from "./store";

const row = (seq: number, type: StoreRow["type"], data: StoreRow["data"]): StoreRow =>
    ({ id: `row-${seq}`, session_id: "s", type, seq, data }) as StoreRow;

const user = (seq: number) => row(seq, "user", { text: `user ${seq}` });
const assistant = (seq: number) =>
    row(seq, "assistant", {
        content: [{ type: "text", text: `reply ${seq}` }],
        model: { providerID: "p", id: "m" },
    });
const instruction = (seq: number) =>
    row(seq, "system", { text: "Today's date is now: Wed Sep 23 2026", metadata: { k: 1 } });

function fakeReader(rows: StoreRow[]) {
    return {
        messageById: (_session: string, id: string) =>
            rows.find((candidate) => candidate.id === id) ?? null,
        rawRowsThrough: (_session: string, through: number, limit: number) =>
            rows
                .filter((candidate) => candidate.seq <= through && candidate.type !== "idle")
                .sort((a, b) => b.seq - a.seq)
                .slice(0, limit),
    };
}

describe("OpenCode 2 rows the host serves by id", () => {
    it("classifies rows the way the host renders them into a draft", () => {
        expect(hostServesRowById(user(1))).toBe(true);
        expect(hostServesRowById(assistant(2))).toBe(true);
        expect(hostServesRowById(instruction(3))).toBe(false);
        expect(hostServesRowById(row(4, "user", { text: "" }))).toBe(false);
        expect(
            hostServesRowById(row(5, "shell", { command: "ls", metadata: { background: true } })),
        ).toBe(false);
        expect(hostServesRowById(row(6, "assistant", { content: [] }))).toBe(false);
        expect(hostServesRowById(row(7, "idle", { outcome: "succeeded" }))).toBe(false);
    });

    it("keeps instruction rows in the ordinal space but flags them off the enumerable shape", () => {
        const projected = rawMessages([user(1), assistant(2), instruction(3), user(4)]);
        expect(projected.map((message) => message.ordinal)).toEqual([1, 2, 3, 4]);
        expect(projected.map(isHostUnservedRow)).toEqual([false, false, true, false]);
        expect(Object.keys(projected[2]!)).toEqual(["id", "ordinal", "role", "createdAt", "parts"]);
    });

    it("maps a boundary on an instruction row to the nearest earlier served row", () => {
        const rows = [user(1), assistant(2), instruction(3), instruction(4), user(5)];
        expect(servedBoundaryRow(fakeReader(rows), "s", "row-4")?.id).toBe("row-2");
        expect(servedBoundaryRow(fakeReader(rows), "s", "row-2")?.id).toBe("row-2");
        expect(servedBoundaryRow(fakeReader(rows), "s", "missing")).toBeNull();
        expect(servedBoundaryRow(fakeReader([instruction(1)]), "s", "row-1")).toBeNull();
    });

    it("walks back across more than one page of unserved rows", () => {
        const rows = [user(1)];
        for (let seq = 2; seq <= 130; seq++) rows.push(instruction(seq));
        expect(servedBoundaryRow(fakeReader(rows), "s", "row-130")?.id).toBe("row-1");
    });
});
