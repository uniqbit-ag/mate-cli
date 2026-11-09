import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { runCommand } from "../tools/setup/utils";

const require = createRequire(import.meta.url);
const MISSING = "bundled skills CLI is missing. Reinstall Mate to restore it.";

export type SkillsCliLocation = { bin: string; version: string } | { missing: string };

export function resolveSkillsCli(): SkillsCliLocation {
  try {
    const manifestPath = require.resolve("skills/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      version?: string;
      bin?: Record<string, string>;
    };
    if (!manifest.version || !manifest.bin?.skills) return { missing: MISSING };
    const bin = path.resolve(path.dirname(manifestPath), manifest.bin.skills);
    return fs.existsSync(bin) ? { bin, version: manifest.version } : { missing: MISSING };
  } catch {
    return { missing: MISSING };
  }
}

export const skillsCliDeps = {
  locate: (): SkillsCliLocation => resolveSkillsCli(),
  run: runCommand,
};

export function runSkillsCli(args: string[], cwd: string): Promise<void> {
  const location = skillsCliDeps.locate();
  if ("missing" in location) return Promise.reject(new Error(location.missing));
  const js = location.bin.endsWith(".js") || location.bin.endsWith(".mjs");
  return skillsCliDeps.run(
    js ? process.execPath : location.bin,
    js ? [location.bin, ...args] : args,
    {
      cwd,
    },
  );
}
