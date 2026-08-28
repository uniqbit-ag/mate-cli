// Synchronous module loader that strips TypeScript types itself. Node's
// built-in .ts loading refuses files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly where the
// published plugin lives — so the hook shims register this loader before
// importing their src/hooks/*.ts implementation.
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// stripTypeScriptTypes emits an ExperimentalWarning; hooks must keep stderr
// clean because Claude Code surfaces it to the user on non-zero exits.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes("stripTypeScriptTypes")) return;
  emitWarning.call(process, warning, ...args);
};

// Source imports are extensionless, which node's ESM resolver refuses. Probe
// the TypeScript candidates the type-checker resolves so a hook module can
// import the runtime subpath the same way the rest of the source tree does.
const TS_CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(specifier, context);
    }
    const base = new URL(specifier, context.parentURL);
    for (const suffix of TS_CANDIDATE_SUFFIXES) {
      const candidate = new URL(`${base.href}${suffix}`);
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module", shortCircuit: true };
      }
    }
    return next(specifier, context);
  },

  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source),
      shortCircuit: true,
    };
  },
});
