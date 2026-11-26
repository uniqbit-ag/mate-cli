import { expect, test } from "bun:test";
import type { McpManagerState } from "@uniqbit/mate-core/studio";

import { referenceText, withoutEntry } from "./mcp-model";

const state: McpManagerState = {
  catalog: {
    servers: { "acme-api": { command: "acme-api-mcp" }, "acme-db": { command: "acme-db-mcp" } },
    groups: { "acme-data": ["acme-api", "acme-db"] },
    enabled: { groups: ["acme-data"] },
  },
  audiences: { analyst: { disable: { servers: ["acme-db"] } }, support: {} },
};

test("deleting a server names where it is used and removes it there", () => {
  expect(referenceText(state, "servers", "acme-db")).toBe("group acme-data and audience analyst");
  const next = withoutEntry(state, "servers", "acme-db");
  expect(JSON.stringify(next)).not.toContain("acme-db");
  expect(next.catalog?.groups).toEqual({ "acme-data": ["acme-api"] });
});
