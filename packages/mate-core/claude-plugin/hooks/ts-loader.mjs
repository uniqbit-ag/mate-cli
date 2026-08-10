// Synchronous module loader that strips TypeScript types itself. Node's
// built-in .ts loading refuses files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly where the
// published plugin lives — so the hook shims register this loader before
// importing their src/hooks/*.ts implementation.
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

function existingTsCandidate(specifier, parentURL) {
  const base = new URL(specifier, parentURL);
  for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
    try {
      if (fs.existsSync(fileURLToPath(candidate))) return candidate;
    } catch {
      /* non-file URL */
    }
  }
  return null;
}

// stripTypeScriptTypes emits an ExperimentalWarning; hooks must keep stderr
// clean because Claude Code surfaces it to the user on non-zero exits.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes("stripTypeScriptTypes")) return;
  emitWarning.call(process, warning, ...args);
};

registerHooks({
  // The src tree uses bun-style extensionless relative imports; node's ESM
  // resolver refuses those, so map them onto their .ts sources here.
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
        const candidate = existingTsCandidate(specifier, context.parentURL);
        if (candidate) return { url: candidate, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      // strip-only: hook-graph sources must avoid TS parameter properties,
      // enums, and namespaces (this node API refuses transform mode).
      source: stripTypeScriptTypes(source),
      shortCircuit: true,
    };
  },
});
