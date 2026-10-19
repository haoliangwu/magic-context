// Import the provider from disk so worker-script URLs are filesystem paths, as in installed OpenCode plugins.
if (process.argv.some((argument) => argument.endsWith("embedding-worker-process.js"))) {
    throw new Error("embedding subprocess restarted the compiled host instead of running Bun");
}
const entry = process.env.ORT_PROBE_LOAD_ENTRY;
if (!entry) throw new Error("ORT_PROBE_LOAD_ENTRY is required");
console.log("Compiled host Bun", process.versions.bun);
await import(entry);

export {};
