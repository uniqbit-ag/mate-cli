#!/usr/bin/env bun
/**
 * Release hook (`after:bump`): pins the image inputs and locks to the release
 * being prepared. Kept as the hook path; the work is `image-pins.ts sync`.
 *
 *   bun scripts/sync-image-inputs.ts <version> [workspace-root]
 */
import { sync } from "./image-pins";

if (import.meta.main) {
  process.exit(await sync(process.argv.slice(2)));
}
