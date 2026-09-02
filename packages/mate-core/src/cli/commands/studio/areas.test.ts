import { describe, expect, test } from "bun:test";

import { readSpecAreas } from "./areas";

describe("readSpecAreas", () => {
  test("unions frontmatter areas with inline requirement bindings", async () => {
    const content = [
      "---",
      "type: spec",
      "capability: acme-checkout",
      "areas: [acme]",
      "---",
      "",
      "### Requirement: One",
      "**Area:** `acme`",
      "",
      "### Requirement: Two",
      "**Area:** `docs`",
      "",
    ].join("\n");

    const areas = await readSpecAreas(
      "/companions/acme/openspec/specs",
      "acme-checkout",
      async (filePath) => {
        expect(filePath).toBe("/companions/acme/openspec/specs/acme-checkout/spec.md");
        return content;
      },
    );

    expect(areas).toEqual(["acme", "docs"]);
  });

  test("reads paired scopes metadata", async () => {
    const content = [
      "---",
      "scopes:",
      "  - repository: acme/store",
      "    area: docs",
      "---",
      "",
    ].join("\n");

    expect(await readSpecAreas("/specs", "acme-docs", async () => content)).toEqual(["docs"]);
  });

  test("does not read past the marker's own line", async () => {
    const content = [
      "### Requirement: One",
      "**Area:** every Area listed",
      "",
      "- **WHEN** a spec body mentions `packages/acme` in prose",
      "- **THEN** the prose is not an Area",
      "",
      "### Requirement: Two",
      "**Area:** `docs`",
      "",
    ].join("\n");

    expect(await readSpecAreas("/specs", "acme-docs", async () => content)).toEqual(["docs"]);
  });

  test("ignores a spec that only writes about the marker", async () => {
    const content = [
      "### Requirement: Markers",
      "Every requirement SHALL carry an `**Area:**` marker naming the Areas it binds.",
      "**Area:** `docs`",
      "",
    ].join("\n");

    expect(await readSpecAreas("/specs", "acme-docs", async () => content)).toEqual(["docs"]);
  });

  test("returns no areas when the spec declares none", async () => {
    expect(await readSpecAreas("/specs", "acme-docs", async () => "# Spec\n")).toEqual([]);
  });

  test("returns no areas when the spec cannot be read", async () => {
    expect(
      await readSpecAreas("/specs", "acme-docs", async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });
});
