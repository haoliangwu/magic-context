#!/usr/bin/env node
/**
 * Executable entry for @cortexkit/magic-context. The commands live in
 * `./cli` so tests can import `main` without starting the CLI.
 */
import { main } from "./cli";

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
