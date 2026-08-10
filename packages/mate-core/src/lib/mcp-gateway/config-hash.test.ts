import { describe, expect, test } from "bun:test";

import type { CompanionMcpServer } from "./companion-mcp-config";
import { serverConfigHash } from "./config-hash";

function server(overrides: Partial<CompanionMcpServer> = {}): CompanionMcpServer {
  return {
    name: "docs",
    command: "docs-mcp",
    args: ["--flag"],
    env: { A: "1", B: "2" },
    cwd: "/companions/acme",
    isolation: "shared",
    enabled: true,
    ...overrides,
  };
}

describe("serverConfigHash", () => {
  test("is stable for identical definitions", () => {
    expect(serverConfigHash(server())).toBe(serverConfigHash(server()));
  });

  test("is independent of env key order", () => {
    expect(serverConfigHash(server({ env: { B: "2", A: "1" } }))).toBe(
      serverConfigHash(server({ env: { A: "1", B: "2" } })),
    );
  });

  test("ignores name, isolation, and enabled", () => {
    const base = serverConfigHash(server());
    expect(serverConfigHash(server({ name: "renamed" }))).toBe(base);
    expect(serverConfigHash(server({ isolation: "connection" }))).toBe(base);
    expect(serverConfigHash(server({ enabled: false }))).toBe(base);
  });

  test("changes when command, args, env values, or cwd change", () => {
    const base = serverConfigHash(server());
    expect(serverConfigHash(server({ command: "other" }))).not.toBe(base);
    expect(serverConfigHash(server({ args: ["--other"] }))).not.toBe(base);
    expect(serverConfigHash(server({ env: { A: "1", B: "3" } }))).not.toBe(base);
    expect(serverConfigHash(server({ cwd: "/elsewhere" }))).not.toBe(base);
  });

  test("distinguishes arg/env boundary ambiguity", () => {
    expect(serverConfigHash(server({ args: ["a", "b"] }))).not.toBe(
      serverConfigHash(server({ args: ["a b"] })),
    );
  });
});
