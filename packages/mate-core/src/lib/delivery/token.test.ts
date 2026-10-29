import { describe, expect, test } from "bun:test";

import { FORGE_TOKEN_ENV, ghAuthEnv, resolveForgeToken } from "./token";

const noGh = async (): Promise<string | null> => null;

describe("resolveForgeToken", () => {
  test("MATE_GIT_TOKEN wins and the GitHub CLI is not asked", async () => {
    let asked = false;
    const resolved = await resolveForgeToken({
      env: { [FORGE_TOKEN_ENV]: " tok-1 " },
      ghToken: async () => {
        asked = true;
        return "tok-gh";
      },
    });
    expect(resolved).toEqual({ token: "tok-1", source: "MATE_GIT_TOKEN" });
    expect(asked).toBe(false);
  });

  test("falls back to the GitHub CLI", async () => {
    expect(await resolveForgeToken({ env: {}, ghToken: async () => "tok-gh" })).toEqual({
      token: "tok-gh",
      source: "gh",
    });
  });

  test("other token variables are ignored", async () => {
    expect(
      await resolveForgeToken({
        env: { GITHUB_TOKEN: "ci-token", GH_TOKEN: "ci-token" },
        ghToken: noGh,
      }),
    ).toBeNull();
  });

  test("an empty variable counts as unset", async () => {
    expect(await resolveForgeToken({ env: { [FORGE_TOKEN_ENV]: "  " }, ghToken: noGh })).toBeNull();
  });
});

describe("ghAuthEnv", () => {
  test("drops the token variables gh would report instead of its stored login", () => {
    const env = ghAuthEnv({ PATH: "/usr/bin", GH_TOKEN: "a", GITHUB_TOKEN: "b" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
