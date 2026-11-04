import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { FORGE_TOKEN_ENV, resolveForgeToken } from "./token";

describe("resolveForgeToken", () => {
  test("reads MATE_GIT_TOKEN", async () => {
    expect(await resolveForgeToken({ env: { [FORGE_TOKEN_ENV]: " tok-1 " } })).toEqual({
      token: "tok-1",
      source: "MATE_GIT_TOKEN",
    });
  });

  test("other token variables are ignored", async () => {
    expect(
      await resolveForgeToken({ env: { GITHUB_TOKEN: "ci-token", GH_TOKEN: "ci-token" } }),
    ).toBeNull();
  });

  test("an empty variable counts as unset", async () => {
    expect(await resolveForgeToken({ env: { [FORGE_TOKEN_ENV]: "  " } })).toBeNull();
  });
});

describe("no stored credential is read", () => {
  test("the token and forge modules start no process and never name the GitHub CLI", async () => {
    for (const file of ["token.ts", "forge.ts", "repository-access.ts"]) {
      const source = await fs.readFile(path.join(import.meta.dir, file), "utf8");
      expect(source).not.toContain("child_process");
      expect(source).not.toMatch(/["'`]gh["'`]|gh auth/);
    }
  });
});
