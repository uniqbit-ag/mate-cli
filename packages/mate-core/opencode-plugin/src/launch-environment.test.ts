import { describe, expect, test } from "bun:test";

import { pluginLaunchEnvironment, runsInSharedService } from "./launch-environment";

const PRIVATE_ARGV = ["bun", "/$bunfs/root/opencode", "/repo", "--standalone"];
const SERVICE_ARGV = ["bun", "/$bunfs/root/opencode", "serve", "--service"];

const INHERITED = {
  MATE_REPO_PATH: "/other/repo",
  MATE_ARTIFACT_PATH: "/other/companion",
  MATE_REPO_ID: "other",
};

describe("runsInSharedService", () => {
  test("matches the shared background service", () => {
    expect(runsInSharedService(SERVICE_ARGV)).toBe(true);
    expect(runsInSharedService(["opencode", "serve", "--port", "1", "--service"])).toBe(true);
  });

  test("does not match a private server or a plain serve", () => {
    expect(runsInSharedService(PRIVATE_ARGV)).toBe(false);
    expect(runsInSharedService(["opencode", "serve", "--port", "4096"])).toBe(false);
    expect(runsInSharedService(["opencode", "run", "--service"])).toBe(false);
    expect(runsInSharedService([])).toBe(false);
  });
});

describe("pluginLaunchEnvironment", () => {
  test("a guidance payload outside the service is a managed launch", () => {
    const env = { ...INHERITED, MATE_GUIDANCE_JSON: '{"version":1}' };
    expect(pluginLaunchEnvironment(env, PRIVATE_ARGV)).toBe(env);
  });

  test("inherited variables without a payload are not trusted", () => {
    expect(pluginLaunchEnvironment(INHERITED, PRIVATE_ARGV)).toEqual({});
  });

  test("a masked or blank payload is not a managed launch", () => {
    expect(pluginLaunchEnvironment({ ...INHERITED, MATE_GUIDANCE_JSON: "" }, PRIVATE_ARGV)).toEqual(
      {},
    );
    expect(
      pluginLaunchEnvironment({ ...INHERITED, MATE_GUIDANCE_JSON: "  \n" }, PRIVATE_ARGV),
    ).toEqual({});
  });

  test("the shared service ignores its environment, payload or not", () => {
    const withPayload = { ...INHERITED, MATE_GUIDANCE_JSON: '{"version":1}' };
    expect(pluginLaunchEnvironment(withPayload, SERVICE_ARGV)).toEqual({});
    expect(pluginLaunchEnvironment(INHERITED, SERVICE_ARGV)).toEqual({});
    expect(pluginLaunchEnvironment({ ...INHERITED, MATE_GUIDANCE_JSON: "" }, SERVICE_ARGV)).toEqual(
      {},
    );
  });
});
