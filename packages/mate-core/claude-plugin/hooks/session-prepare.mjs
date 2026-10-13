#!/usr/bin/env node
/**
 * Thin shim for src/hooks/session-prepare.ts, loaded through ts-loader.mjs: the installed
 * plugin sits inside node_modules, where node's native type stripping is off.
 */
import "./ts-loader.mjs";

const { run } = await import("../../src/hooks/session-prepare.ts");
process.exitCode = await run();
