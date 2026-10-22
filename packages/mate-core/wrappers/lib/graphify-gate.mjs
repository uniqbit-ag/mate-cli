#!/usr/bin/env node
// Thin shim: the gate lives in src/tools/setup/capabilities/graphify-gate.ts,
// loaded through the plugin's ts-loader because the installed package sits
// inside node_modules where node's native type stripping is disabled.
import "../../claude-plugin/hooks/ts-loader.mjs";

const { runGraphifyGate } = await import("../../src/tools/setup/capabilities/graphify-gate.ts");
process.exitCode = await runGraphifyGate(process.argv.slice(2));
