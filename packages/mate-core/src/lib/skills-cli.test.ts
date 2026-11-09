import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import semver from "semver";

import { skillsCliDeps } from "./skills-cli";

test("resolves the bundled CLI at the exact version mate-core pins", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const pinned = manifest.dependencies.skills;
  const location = skillsCliDeps.locate();
  if ("missing" in location) throw new Error(location.missing);

  expect(semver.valid(pinned)).toBe(pinned);
  expect(location.version).toBe(pinned);
  expect(fs.existsSync(location.bin)).toBe(true);
});
