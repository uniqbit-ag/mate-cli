import { describe, expect, test } from "bun:test";

import {
  isPluginAllowed,
  parseAllowedPlugins,
  PluginPolicyError,
  readPluginPolicy,
} from "./policy";

describe("parseAllowedPlugins", () => {
  test("absent is no policy, blank is an empty policy", () => {
    expect(parseAllowedPlugins(undefined)).toBeNull();
    expect(parseAllowedPlugins("")).toEqual({ exact: [], scopes: [] });
    expect(isPluginAllowed(parseAllowedPlugins(""), "@acme/reader")).toBe(false);
  });

  test("matches exact names and scope patterns only", () => {
    const policy = parseAllowedPlugins("@acme/*, plain-plugin, @other/one");
    expect(isPluginAllowed(policy, "@acme/reader")).toBe(true);
    expect(isPluginAllowed(policy, "plain-plugin")).toBe(true);
    expect(isPluginAllowed(policy, "@other/one")).toBe(true);
    expect(isPluginAllowed(policy, "@other/two")).toBe(false);
    expect(isPluginAllowed(policy, "@acmeevil/reader")).toBe(false);
    expect(isPluginAllowed(null, "anything")).toBe(true);
  });

  test("rejects malformed entries", () => {
    for (const bad of ["*", "@acme/*/x", "@acme", "a,,b", "@acme/re*der", "../x"]) {
      expect(() => parseAllowedPlugins(bad)).toThrow(PluginPolicyError);
    }
  });

  test("reads the environment variable", () => {
    expect(readPluginPolicy({ MATE_ALLOWED_PLUGINS: "@acme/*" })?.scopes).toEqual(["@acme/"]);
    expect(readPluginPolicy({})).toBeNull();
  });
});
