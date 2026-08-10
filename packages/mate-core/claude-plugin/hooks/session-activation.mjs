#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/session-activation.ts, loaded
// through ts-loader.mjs because the installed plugin sits inside node_modules
// where node's native type stripping is disabled.
import "./ts-loader.mjs";

const { run } = await import("../../src/hooks/session-activation.ts");
process.exitCode = await run();
