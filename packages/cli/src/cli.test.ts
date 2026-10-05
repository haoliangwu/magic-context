import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { main } from "./cli";
import * as setupCommand from "./commands/setup";
import { PromptCancelledError } from "./lib/prompts";

const restores: Array<() => void> = [];
afterEach(() => {
    for (const restore of restores.splice(0)) restore();
});

describe("CLI entry", () => {
    it("treats a cancelled setup prompt as a clean exit", async () => {
        const setup = spyOn(setupCommand, "runSetup").mockImplementation(async () => {
            throw new PromptCancelledError();
        });
        restores.push(() => setup.mockRestore());

        // The cancellation must be handled inside main(): an escaping rejection
        // reaches the process-level handler, which prints "Cancelled." a second
        // time and exits 1.
        await expect(main(["setup"])).resolves.toBe(0);
        expect(setup).toHaveBeenCalledTimes(1);
    });
});
