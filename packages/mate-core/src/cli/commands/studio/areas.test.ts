import { describe, expect, test } from "bun:test";

import { readSpecScopes } from "./areas";

const read = (content: string) => readSpecScopes("/specs", "acme-docs", async () => content);

describe("readSpecScopes", () => {
  test("pairs the top-level repository with its areas and inline bindings", async () => {
    const content = [
      "---",
      "type: spec",
      "capability: acme-checkout",
      "repository: acme/shop",
      "areas: [packages/web]",
      "---",
      "",
      "### Requirement: One",
      "**Area:** `packages/web`",
      "",
      "### Requirement: Two",
      "**Area:** `docs`",
      "",
    ].join("\n");

    const scopes = await readSpecScopes(
      "/companions/acme/openspec/specs",
      "acme-checkout",
      async (filePath) => {
        expect(filePath).toBe("/companions/acme/openspec/specs/acme-checkout/spec.md");
        return content;
      },
    );

    expect(scopes).toEqual([
      { repository: "acme/shop", area: "docs" },
      { repository: "acme/shop", area: "packages/web" },
    ]);
  });

  test("keeps a repository that names no Area", async () => {
    expect(await read("---\nrepository: acme/shop\n---\n")).toEqual([{ repository: "acme/shop" }]);
  });

  test("reads paired scopes metadata", async () => {
    const content = [
      "---",
      "scopes:",
      "  - repository: acme/store",
      "    area: docs",
      "  - repository: acme/blog",
      "    area: docs",
      "---",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([
      { repository: "acme/blog", area: "docs" },
      { repository: "acme/store", area: "docs" },
    ]);
  });

  test("pairs inline Areas with the only repository the scopes name", async () => {
    const content = [
      "---",
      "scopes:",
      "  - repository: acme",
      "    area: .",
      "---",
      "",
      "### Requirement: One",
      "**Area:** `packages/web`",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([
      { repository: "acme", area: "." },
      { repository: "acme", area: "packages/web" },
    ]);
  });

  test("leaves inline Areas without a repository when the scopes name several", async () => {
    const content = [
      "---",
      "scopes:",
      "  - repository: acme/shop",
      "    area: web",
      "  - repository: acme/blog",
      "    area: web",
      "---",
      "**Area:** `docs`",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([
      { repository: "acme/blog", area: "web" },
      { repository: "acme/shop", area: "web" },
      { area: "docs" },
    ]);
  });

  test("reads every Area on a marker line", async () => {
    const content = [
      "---",
      "repository: acme/shop",
      "---",
      "**Area:** `packages/web`, `packages/api`",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([
      { repository: "acme/shop", area: "packages/api" },
      { repository: "acme/shop", area: "packages/web" },
    ]);
  });

  test("reads only the Area list right after the marker", async () => {
    const content = [
      "---",
      "repository: acme/shop",
      "---",
      "**Area:** `acme` (see `acme/src/sub-1/sub-2` for details)",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([{ repository: "acme/shop", area: "acme" }]);
  });

  test("pairs top-level Areas with the only scopes repository, like inline ones", async () => {
    const content = [
      "---",
      "areas: [acme]",
      "scopes:",
      "  - repository: acme-org/acme",
      "    area: docs",
      "---",
      "**Area:** `acme`",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([
      { repository: "acme-org/acme", area: "acme" },
      { repository: "acme-org/acme", area: "docs" },
    ]);
  });

  test("reads a linked registry ID as its identity, so one repository named both ways counts once", async () => {
    const content = [
      "---",
      "scopes:",
      "  - repository: acme",
      "    area: docs",
      "  - repository: acme-org/acme",
      "    area: web",
      "  - repository: acme/unknown",
      "    area: web",
      "---",
      "",
    ].join("\n");
    const scopes = await readSpecScopes(
      "/specs",
      "acme-docs",
      async () => content,
      new Map([["acme", "acme-org/acme"]]),
    );

    expect(scopes).toEqual([
      { repository: "acme-org/acme", area: "docs" },
      { repository: "acme-org/acme", area: "web" },
      { repository: "acme/unknown", area: "web" },
    ]);

    const inline = await readSpecScopes(
      "/specs",
      "acme-docs",
      async () =>
        "---\nscopes:\n  - repository: acme\n    area: docs\n  - repository: acme-org/acme\n    area: web\n---\n**Area:** `api`\n",
      new Map([["acme", "acme-org/acme"]]),
    );
    expect(inline).toContainEqual({ repository: "acme-org/acme", area: "api" });
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

    expect(await read(content)).toEqual([{ area: "docs" }]);
  });

  test("ignores a spec that only writes about the marker", async () => {
    const content = [
      "### Requirement: Markers",
      "Every requirement SHALL carry an `**Area:**` marker naming the Areas it binds.",
      "**Area:** `docs`",
      "",
    ].join("\n");

    expect(await read(content)).toEqual([{ area: "docs" }]);
  });

  test("returns no pairs when the spec declares none", async () => {
    expect(await read("# Spec\n")).toEqual([]);
  });

  test("returns no pairs when the spec cannot be read", async () => {
    expect(
      await readSpecScopes("/specs", "acme-docs", async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });
});
