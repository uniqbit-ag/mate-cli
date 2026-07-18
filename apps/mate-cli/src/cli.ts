#!/usr/bin/env bun
import { main } from "./cli/main";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
