import fs from "node:fs";
import { expect, test } from "bun:test";

import { skillsCliDeps } from "./skills-cli";
import { toolVersion } from "./tool-manifest";

test("resolves the skills CLI at the exact version mate-core pins", () => {
  const location = skillsCliDeps.locate();
  if ("missing" in location) throw new Error(location.missing);

  expect(location.version).toBe(toolVersion("skills"));
  expect(fs.existsSync(location.bin)).toBe(true);
});
