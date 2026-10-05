/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    isHostRenderedSystemMessage,
    isHostUnservedRow,
    markHostUnservedRow,
    retreatPastHostUnservedRows,
    snapTerminalCompartmentToServedRow,
} from "./host-served-rows";

const line = (ordinal: number, unserved = false) => {
    const value = { ordinal, messageId: `m${ordinal}` };
    return unserved ? markHostUnservedRow(value) : value;
};

describe("host-served rows", () => {
    it("marks rows without changing their enumerable shape", () => {
        const marked = markHostUnservedRow({ ordinal: 1, messageId: "m1" });
        expect(isHostUnservedRow(marked)).toBe(true);
        expect(JSON.stringify(marked)).toBe('{"ordinal":1,"messageId":"m1"}');
        expect(isHostUnservedRow({ ordinal: 1 })).toBe(false);
    });

    it("moves an exclusive end back past unserved rows but never below the floor", () => {
        const rows = [line(5), line(6), line(7, true), line(8, true), line(9)];
        expect(retreatPastHostUnservedRows(rows, 9, 5)).toBe(7);
        expect(retreatPastHostUnservedRows(rows, 10, 5)).toBe(10);
        expect(retreatPastHostUnservedRows(rows, 9, 8)).toBe(8);
        expect(retreatPastHostUnservedRows([line(5), line(6)], 7, 5)).toBe(7);
    });

    it("ends the final compartment on the nearest served row", () => {
        const lines = [line(1), line(2), line(3), line(4, true)];
        const result = snapTerminalCompartmentToServedRow(
            [
                { startMessage: 1, endMessage: 2, endMessageId: "m2" },
                { startMessage: 3, endMessage: 4, endMessageId: "m4" },
            ],
            lines,
        );
        expect(result.snapped).toBe(true);
        expect(result.compartments).toEqual([
            { startMessage: 1, endMessage: 2, endMessageId: "m2" },
            { startMessage: 3, endMessage: 3, endMessageId: "m3" },
        ]);
    });

    it("drops a final compartment that holds only unserved rows", () => {
        const lines = [line(1), line(2), line(3, true)];
        const result = snapTerminalCompartmentToServedRow(
            [
                { startMessage: 1, endMessage: 2, endMessageId: "m2" },
                { startMessage: 3, endMessage: 3, endMessageId: "m3" },
            ],
            lines,
        );
        expect(result.compartments).toEqual([
            { startMessage: 1, endMessage: 2, endMessageId: "m2" },
        ]);
    });

    it("leaves compartments alone when every row is served", () => {
        const compartments = [{ startMessage: 1, endMessage: 2, endMessageId: "m2" }];
        const result = snapTerminalCompartmentToServedRow(compartments, [line(1), line(2)]);
        expect(result).toEqual({ compartments, snapped: false });
    });

    it("recognizes only id-less system messages as host-rendered instruction rows", () => {
        expect(isHostRenderedSystemMessage({ info: { role: "system" } })).toBe(true);
        expect(isHostRenderedSystemMessage({ info: { role: "system", id: "row" } })).toBe(false);
        expect(isHostRenderedSystemMessage({ info: { role: "user" } })).toBe(false);
    });
});
