import fs from "node:fs";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import semver from "semver";

import {
  holdToolNotices,
  readToolManifest,
  toolVersion,
  warnOnVersionDrift,
} from "./tool-manifest";

const corePackage = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("tool manifest", () => {
  test.each(Object.entries(readToolManifest().tools))("%s names an exact version", (_, entry) => {
    expect(semver.valid(entry.version)).toBe(entry.version);
  });

  test.each([
    ["@fission-ai/openspec", "openspec"],
    ["skills", "skills"],
    ["react-doctor", "react-doctor"],
  ])("mate-core's %s dependency equals the manifest", (dependency, tool) => {
    expect(corePackage.dependencies[dependency]).toBe(toolVersion(tool));
  });

  test("a held drift warning is written only on release", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const release = holdToolNotices();
      warnOnVersionDrift("rtk", "rtk 0.0.1", "acme install", "/acme/bin/rtk");
      expect(stderr).not.toHaveBeenCalled();
      release();
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "rtk 0.0.1 is installed at /acme/bin/rtk",
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
