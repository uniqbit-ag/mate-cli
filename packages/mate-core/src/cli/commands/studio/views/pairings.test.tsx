/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioInventoryCompanion } from "../inventory";
import { Pairings } from "./pairings";

function companion(pairings: StudioInventoryCompanion["pairings"]): StudioInventoryCompanion {
  return { path: "/home/dev/.mate/companions/acme-companion", health: "ready", pairings };
}

describe("Pairings", () => {
  it("lists each Working Repository as context rather than a selection", () => {
    const markup = String(
      <Pairings
        companion={companion([
          {
            repositoryId: "acme-org/acme",
            repositoryPath: "/code/acme",
            health: "ready",
            ambiguous: false,
          },
        ])}
      />,
    );
    expect(markup).toContain("acme-org/acme");
    expect(markup).toContain("/code/acme");
    expect(markup).not.toContain("<select");
  });

  it("marks a repository paired to more than one companion", () => {
    const markup = String(
      <Pairings
        companion={companion([
          {
            repositoryId: "acme-org/acme",
            repositoryPath: "/code/acme",
            health: "ready",
            ambiguous: true,
          },
        ])}
      />,
    );
    expect(markup).toContain("also paired elsewhere");
  });

  it("reports a pairing whose health is not ready", () => {
    const markup = String(
      <Pairings
        companion={companion([
          {
            repositoryId: "acme-org/acme",
            repositoryPath: "/code/acme",
            health: "missing",
            ambiguous: false,
          },
        ])}
      />,
    );
    expect(markup).toContain('class="chip chip-invalid">missing<');
  });

  it("states when a companion has none", () => {
    expect(String(<Pairings companion={companion([])} />)).toContain(
      "no linked working repository",
    );
  });

  it("states when no companion is selected", () => {
    expect(String(<Pairings companion={null} />)).toContain("no linked working repository");
  });

  it("renders a repository identity containing markup characters as text", () => {
    const markup = String(
      <Pairings
        companion={companion([
          {
            repositoryId: "<b>acme</b>",
            repositoryPath: "/code/acme",
            health: "ready",
            ambiguous: false,
          },
        ])}
      />,
    );
    expect(markup).not.toContain("<b>acme</b>");
    expect(markup).toContain("&lt;b&gt;acme&lt;/b&gt;");
  });
});
