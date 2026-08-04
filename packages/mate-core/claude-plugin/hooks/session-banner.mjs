#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/session-banner.ts
// (loaded via node's native TypeScript type stripping, engines node >= 24).
import { run } from "../../src/hooks/session-banner.ts";

process.exitCode = run();
