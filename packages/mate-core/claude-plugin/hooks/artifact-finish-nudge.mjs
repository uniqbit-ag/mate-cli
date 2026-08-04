#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/artifact-finish-nudge.ts
// (loaded via node's native TypeScript type stripping, engines node >= 24).
import { run } from "../../src/hooks/artifact-finish-nudge.ts";

process.exitCode = await run();
