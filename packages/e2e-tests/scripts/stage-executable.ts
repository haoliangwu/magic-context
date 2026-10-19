import { stageExecutable } from "../src/rust-runner/executable-staging";

const [source, name, identifier] = process.argv.slice(2);
if (!source || !name || !identifier) {
    throw new Error("usage: stage-executable.ts <source> <name> <codesign-identifier>");
}
process.stdout.write(`${stageExecutable(source, name, identifier)}\n`);
