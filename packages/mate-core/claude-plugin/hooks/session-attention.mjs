#!/usr/bin/env node
/**
 * Thin shim for the `Notification` entry of src/hooks/session-end.ts, loaded through
 * ts-loader.mjs: the installed plugin sits inside node_modules, where node's native type
 * stripping is off.
 */
import "./ts-loader.mjs";

const { runAttention } = await import("../../src/hooks/session-end.ts");
process.exitCode = await runAttention();
