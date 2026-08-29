#!/usr/bin/env node
/**
 * Build the DSH client bundle (src/client/client.tsx) into the classic-script
 * factory shape the harness's `__ModuleLoader__` requires:
 *
 *   window.__ModuleLoader__.load({ id: "<plugin id>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     // ...bundle body, dependencies resolved through the injected require...
 *     return module.exports;
 *   } });
 *
 * banner / intro / footer mirror the framework's own client pipeline
 * (packages/client/tsdown.client.ts). react, react/jsx-runtime and
 * @deepseek-ai/* stay external — the harness injects them at runtime.
 */
import { build } from "esbuild";

const PLUGIN_ID = "@cortexkit/dsh-magic-context";

await build({
  entryPoints: ["src/client/client.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  jsx: "automatic",
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\n  var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: "return module.exports; } });" },
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
  logLevel: "info",
});