import fs from "node:fs";
import path from "node:path";

import { resolveCommandOnPath } from "../src/tools/setup/utils";

/** The first `openspec` on PATH that is not one of Mate's wrappers. */
export function findRealOpenSpec(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = resolveCommandOnPath("openspec", dir);
    if (!candidate) continue;
    if (fs.readFileSync(candidate, "utf8").includes("_mate_projection_file")) continue;
    return candidate;
  }
  return undefined;
}
