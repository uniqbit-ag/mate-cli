import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getActiveDistribution } from "../distribution";

const require = createRequire(import.meta.url);

/**
 * Resolved wrapper directory: a distribution asset root that ships
 * `wrappers/bin` wins over core's bundled default.
 */
export function getWrapperBinPath(): string {
  for (const root of getActiveDistribution().config.assetRoots ?? []) {
    const candidate = path.join(root, "wrappers", "bin");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}

export function getReactDoctorBinPath(): string {
  try {
    const entryPath = require.resolve("react-doctor");
    return path.resolve(path.dirname(entryPath), "../bin/react-doctor.js");
  } catch {
    return path.resolve(import.meta.dirname, "../../node_modules/.bin/react-doctor");
  }
}
