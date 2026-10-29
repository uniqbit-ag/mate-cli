#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/validate-artifact-path.ts, loaded
// through ts-loader.mjs because the installed plugin sits inside node_modules
// where node's native type stripping is disabled.
//
// Dynamic imports so a load failure still refuses: exit 1 would let the call run.
try {
  await import("./ts-loader.mjs");
  const { run } = await import("../../src/hooks/validate-artifact-path.ts");
  process.exitCode = await run();
} catch (error) {
  // Mirrors guardFailureMessage in src/runtime/tool-guard.ts, which may be what failed to load.
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Mate guardrail could not check this call: ${detail.replaceAll(/\s*\n\s*/g, " ")}\n`,
  );
  process.exitCode = 2;
}
