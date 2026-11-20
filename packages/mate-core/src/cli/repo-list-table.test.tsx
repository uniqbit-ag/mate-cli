/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import type { CompanionListing } from "./commands/companion/list";
import { CompanionListTable } from "./repo-list-table";

function renderLines(listing: CompanionListing): string[] {
  return renderToString(<CompanionListTable listing={listing} />, { columns: 120 })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

describe("CompanionListTable", () => {
  test("renders the connected companions with the active marker", () => {
    const lines = renderLines({
      workingRepository: { id: "acme-two", path: "/work/acme-two" },
      companions: [
        { path: "/work/acme-companion", repositoryId: "acme-two", active: true },
        { path: "/work/acme-companion-two", repositoryId: "acme-two", active: false },
      ],
    });

    expect(lines).toEqual([
      "Connected companion",
      "Active Path",
      "*      /work/acme-companion",
      "       /work/acme-companion-two",
    ]);
  });

  test("renders the linked repositories without an Active column", () => {
    const lines = renderLines({
      companionPath: "/work/acme-companion",
      repositories: [
        { id: "acme", path: "/work/acme" },
        { id: "acme-two", path: "/work/acme-two" },
      ],
    });

    expect(lines).toEqual([
      "Linked repositories",
      "ID       Path",
      "acme     /work/acme",
      "acme-two /work/acme-two",
    ]);
  });
});
