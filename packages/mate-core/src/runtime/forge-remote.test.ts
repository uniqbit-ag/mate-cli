import { describe, expect, test } from "bun:test";

import { remoteIdentity } from "./forge-remote";

describe("remoteIdentity", () => {
  test("gives SSH and HTTPS forms of one repository the same identity", () => {
    expect(remoteIdentity("git@example.com:acme/acme-companion.git")).toBe(
      "example.com/acme/acme-companion",
    );
    expect(remoteIdentity("https://example.com/acme/acme-companion")).toBe(
      "example.com/acme/acme-companion",
    );
  });
});
