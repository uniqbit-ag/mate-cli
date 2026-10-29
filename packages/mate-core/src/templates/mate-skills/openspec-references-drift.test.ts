import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { locateOpenSpec } from "../../lib/openspec-cli";
import {
  findCommandReferences,
  NOTICES_FILE,
  renderOpenSpecNotices,
  renderOpenSpecReferences,
  VENDORED_WORKFLOWS,
} from "./openspec-references";

/** The committed vendored files must equal what the bundled OpenSpec CLI renders. */

const SKILLS_ROOT = import.meta.dirname;

function bundledCli(): string {
  const location = locateOpenSpec();
  if ("missing" in location) throw new Error(location.missing);
  return location.bin;
}
const REFRESH = "run `bun run vendor:openspec` after raising the OpenSpec pin";

describe("vendored OpenSpec references", () => {
  test("equal the output of the bundled OpenSpec CLI", async () => {
    const rendered = await renderOpenSpecReferences(bundledCli());

    const stale: string[] = [];
    for (const [relative, content] of rendered) {
      const committed = await fs
        .readFile(path.join(SKILLS_ROOT, relative), "utf8")
        .catch(() => undefined);
      if (committed !== content) stale.push(relative);
    }
    expect(stale, `stale references; ${REFRESH}`).toEqual([]);
  });

  test("notices carry the bundled OpenSpec license", async () => {
    const committed = await fs
      .readFile(path.join(SKILLS_ROOT, NOTICES_FILE), "utf8")
      .catch(() => undefined);
    expect(committed, `${NOTICES_FILE} is stale; ${REFRESH}`).toBe(
      await renderOpenSpecNotices(bundledCli()),
    );
  });

  test("leave no OpenSpec command reference in the Mate skills", async () => {
    for (const bucket of ["claude", "agents"]) {
      for (const { skill } of VENDORED_WORKFLOWS) {
        const dir = path.join(SKILLS_ROOT, bucket, skill);
        const files = await fs.readdir(dir, { recursive: true });
        for (const file of files.filter((name) => name.endsWith(".md"))) {
          const source = await fs.readFile(path.join(dir, file), "utf8");
          expect(findCommandReferences(source), `${bucket}/${skill}/${file}`).toEqual([]);
        }
      }
    }
  });
});
