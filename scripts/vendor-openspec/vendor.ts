#!/usr/bin/env bun
/**
 * Writes the OpenSpec workflow references the Mate stage skills follow, and their
 * third-party notices, from the OpenSpec CLI bundled with mate-core.
 *
 *   bun scripts/vendor-openspec/vendor.ts   regenerate after raising the OpenSpec pin
 */
import fs from "node:fs/promises";
import path from "node:path";

import { locateOpenSpec } from "../../packages/mate-core/src/lib/openspec-cli";
import {
  NOTICES_FILE,
  renderOpenSpecNotices,
  renderOpenSpecReferences,
} from "../../packages/mate-core/src/templates/mate-skills/openspec-references";

const SKILLS_ROOT = path.resolve(
  import.meta.dirname,
  "../../packages/mate-core/src/templates/mate-skills",
);

const location = locateOpenSpec();
if ("missing" in location) throw new Error(location.missing);
const cli = location.bin;
const files = await renderOpenSpecReferences(cli);
files.set(NOTICES_FILE, await renderOpenSpecNotices(cli));
for (const [relative, content] of files) {
  const target = path.join(SKILLS_ROOT, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
