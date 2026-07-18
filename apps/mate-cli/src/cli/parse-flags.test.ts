import { describe, expect, test } from "bun:test";

import {
  parseAllowedAgents,
  parseCapabilities,
  parseFlags,
  parseGitMode,
  parseOpenSpecSchema,
  parsePackageManagers,
} from "./parse-flags";

describe("parseFlags", () => {
  test("boolean flag with no following value", () => {
    expect(parseFlags(["--verbose"])).toEqual({ verbose: true });
  });

  test("flag followed by another flag is boolean", () => {
    expect(parseFlags(["--foo", "--bar"])).toEqual({ foo: true, bar: true });
  });

  test("flag at end of argv is boolean", () => {
    expect(parseFlags(["--dry-run"])).toEqual({ "dry-run": true });
  });

  test("string flag with a value", () => {
    expect(parseFlags(["--name", "alice"])).toEqual({ name: "alice" });
  });

  test("repeated flag becomes an array", () => {
    expect(parseFlags(["--tag", "a", "--tag", "b"])).toEqual({ tag: ["a", "b"] });
  });

  test("triple repetition appends to array", () => {
    expect(parseFlags(["--tag", "a", "--tag", "b", "--tag", "c"])).toEqual({
      tag: ["a", "b", "c"],
    });
  });

  test("ignores non-flag tokens", () => {
    expect(parseFlags(["cmd", "--foo", "bar"])).toEqual({ foo: "bar" });
  });

  test("empty argv returns empty object", () => {
    expect(parseFlags([])).toEqual({});
  });
});

describe("parseAllowedAgents", () => {
  test("returns undefined when flag is absent", () => {
    expect(parseAllowedAgents({})).toBeUndefined();
  });

  test("wraps single string in an array", () => {
    expect(parseAllowedAgents({ "allowed-agent": "claude" })).toEqual(["claude"]);
  });

  test("passes array through unchanged", () => {
    expect(parseAllowedAgents({ "allowed-agent": ["claude", "opencode"] })).toEqual([
      "claude",
      "opencode",
    ]);
  });
});

describe("parseCapabilities", () => {
  test("returns undefined when flag is absent", () => {
    expect(parseCapabilities({})).toBeUndefined();
  });

  test("maps a single capability name using the full capability config", () => {
    expect(parseCapabilities({ capability: "react-doctor" })).toEqual([{ name: "react-doctor" }]);
    expect(parseCapabilities({ capability: "tokensave" })).toEqual([{ name: "tokensave" }]);
    expect(parseCapabilities({ capability: "headroom" })).toEqual([{ name: "headroom" }]);
  });

  test("maps multiple capability names using the full capability config from setup compatibilities", () => {
    expect(parseCapabilities({ capability: ["react-doctor", "openspec"] })).toEqual([
      { name: "react-doctor" },
      { name: "openspec" },
    ]);
  });

  test("falls back to bare name for unknown capabilities", () => {
    expect(parseCapabilities({ capability: "custom-tool" })).toEqual([{ name: "custom-tool" }]);
  });
});

describe("parsePackageManagers", () => {
  test("returns undefined when flag is absent", () => {
    expect(parsePackageManagers({})).toBeUndefined();
  });

  test("wraps a single package manager in an array", () => {
    expect(parsePackageManagers({ "package-manager": "bun" })).toEqual(["bun"]);
  });

  test("passes repeated package managers through unchanged", () => {
    expect(parsePackageManagers({ "package-manager": ["bun", "uv"] })).toEqual(["bun", "uv"]);
  });
});

describe("parseOpenSpecSchema", () => {
  test("returns undefined when flag is absent", () => {
    expect(parseOpenSpecSchema({})).toBeUndefined();
  });

  test("accepts supported values", () => {
    expect(parseOpenSpecSchema({ "openspec-schema": "mate-v1" })).toBe("mate-v1");
    expect(parseOpenSpecSchema({ "openspec-schema": "default" })).toBe("default");
  });

  test("ignores unsupported values", () => {
    expect(parseOpenSpecSchema({ "openspec-schema": "custom" })).toBeUndefined();
  });
});

describe("parseGitMode", () => {
  test("returns undefined when flag is absent", () => {
    expect(parseGitMode({})).toBeUndefined();
  });

  test("accepts supported values", () => {
    expect(parseGitMode({ "git-mode": "auto" })).toBe("auto");
    expect(parseGitMode({ "git-mode": "default" })).toBe("default");
  });

  test("ignores unsupported values", () => {
    expect(parseGitMode({ "git-mode": "manual" })).toBeUndefined();
  });
});
