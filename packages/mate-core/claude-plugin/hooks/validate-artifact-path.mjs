#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/validate-artifact-path.ts
// (loaded via node's native TypeScript type stripping, engines node >= 24).
import { run } from "../../src/hooks/validate-artifact-path.ts";

process.exitCode = await run();
