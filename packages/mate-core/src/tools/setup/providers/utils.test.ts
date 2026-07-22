import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { getWrapperBinPath } from "../../../lib/package-paths";

describe("package-owned wrappers", () => {
  test.each(["openspec", "graphify"])("ships an executable %s wrapper", async (name) => {
    const wrapperPath = path.join(getWrapperBinPath(), name);
    const stat = await fs.stat(wrapperPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).toBeGreaterThan(0);

    const content = await fs.readFile(wrapperPath, "utf8");
    expect(content).toContain("MATE_ARTIFACT_PATH");
  });
});
