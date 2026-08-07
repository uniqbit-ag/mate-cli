import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { openspecFinisher } from "./openspec";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-openspec-"));
  tempRoots.push(dir);
  return dir;
}

async function seedArchive(
  companionPath: string,
  folder: string,
  capabilities: string[] = [],
): Promise<void> {
  const dir = path.join(companionPath, "openspec", "changes", "archive", folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "proposal.md"), "archived\n", "utf8");
  await Promise.all(
    capabilities.map(async (capability) => {
      const specPath = path.join(dir, "specs", capability, "spec.md");
      await fs.mkdir(path.dirname(specPath), { recursive: true });
      await fs.writeFile(specPath, "delta\n", "utf8");
    }),
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("openspecFinisher.detectProduced", () => {
  test("returns null when nothing is archived", async () => {
    const root = await makeCompanion();

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toBeNull();
  });

  test("finds the dated archive folder with exact active, archive, and canonical spec file paths", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2026-07-14-my-change", ["z-capability", "a-capability"]);

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: "2026-07-14-my-change",
      commitPaths: [
        "openspec/changes/my-change",
        "openspec/changes/archive/2026-07-14-my-change",
        "openspec/specs/a-capability/spec.md",
        "openspec/specs/z-capability/spec.md",
      ],
    });
  });

  test("includes nested delta spec files without staging their entire canonical capability", async () => {
    const root = await makeCompanion();
    const folder = "2026-07-14-my-change";
    await seedArchive(root, folder, ["my-capability"]);
    const nested = path.join(
      root,
      "openspec",
      "changes",
      "archive",
      folder,
      "specs",
      "my-capability",
      "examples",
      "example.md",
    );
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, "example\n", "utf8");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: folder,
      commitPaths: [
        "openspec/changes/my-change",
        `openspec/changes/archive/${folder}`,
        "openspec/specs/my-capability/examples/example.md",
        "openspec/specs/my-capability/spec.md",
      ],
    });
  });

  test("does not match a different change name", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2026-07-14-other-change");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toBeNull();
  });

  test("picks the latest dated folder when a name was archived twice", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2025-01-01-my-change");
    await seedArchive(root, "2026-07-14-my-change");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: "2026-07-14-my-change",
      commitPaths: ["openspec/changes/my-change", "openspec/changes/archive/2026-07-14-my-change"],
    });
  });

  test("is enabled only when the openspec capability is present", async () => {
    const finisher = openspecFinisher("/companion");

    expect(finisher.isEnabled([{ name: "openspec" }])).toBe(true);
    expect(finisher.isEnabled([{ name: "graphify" }])).toBe(false);
  });
});

async function seedArchivedDelta(
  companionPath: string,
  folder: string,
  capability: string,
  frontmatter: string,
  schemaMetadata: string | null = "schema: mate-v1\n",
): Promise<void> {
  const specPath = path.join(
    companionPath,
    "openspec",
    "changes",
    "archive",
    folder,
    "specs",
    capability,
    "spec.md",
  );
  await fs.mkdir(path.dirname(specPath), { recursive: true });
  if (schemaMetadata !== null) {
    await fs.writeFile(
      path.join(companionPath, "openspec", "changes", "archive", folder, ".openspec.yaml"),
      schemaMetadata,
      "utf8",
    );
  }
  await fs.writeFile(
    specPath,
    `${frontmatter}\n\n## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n**Area:** \`packages/mate-core\`\n\n#### Scenario: S\n\n- **WHEN** x\n- **THEN** y\n`,
    "utf8",
  );
}

async function seedCanonical(
  companionPath: string,
  capability: string,
  source: string,
): Promise<void> {
  const specPath = path.join(companionPath, "openspec", "specs", capability, "spec.md");
  await fs.mkdir(path.dirname(specPath), { recursive: true });
  await fs.writeFile(specPath, source, "utf8");
}

function readCanonical(companionPath: string, capability: string): Promise<string> {
  return fs.readFile(path.join(companionPath, "openspec", "specs", capability, "spec.md"), "utf8");
}

const BARE_CANONICAL =
  "# cap Specification\n\n## Purpose\nA capability.\n\n## Requirements\n\n### Requirement: R\n\nIt SHALL work.\n**Area:** `packages/mate-core`\n\n#### Scenario: S\n\n- **WHEN** x\n- **THEN** y\n";

const SINGLE_SCOPE = `---
type: delta-spec
change: probe
capability: cap
tags: [openspec/change, openspec/spec, openspec/delta]
scopes:
  - repository: acme/product
    area: packages/mate-core
---`;

describe("openspecFinisher frontmatter reconciliation", () => {
  test("reconciles a canonical spec after a fresh archive", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE);
    await seedCanonical(root, "cap", BARE_CANONICAL);

    const result = await openspecFinisher(root, () => ({
      status: 0,
      stdout: `Change 'probe' archived as '${folder}'.`,
      stderr: "",
    })).produce("probe");

    expect(result.ok).toBe(true);
    expect(await readCanonical(root, "cap")).toContain("repository: acme/product");
  });

  test("a bare canonical spec gains the projected flat block", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE);
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");

    const canonical = await readCanonical(root, "cap");
    expect(canonical.startsWith("---\n")).toBe(true);
    expect(canonical).toContain("type: spec");
    expect(canonical).toContain("capability: cap");
    expect(canonical).toContain("repository: acme/product");
    expect(canonical).toContain("areas: [packages/mate-core]");
    expect(canonical).toContain("tags: [openspec/spec]");
    /** Delta-only keys never carry over, and the body survives intact. */
    expect(canonical).not.toContain("change: probe");
    expect(canonical).not.toContain("scopes:");
    expect(canonical).toContain("### Requirement: R");
    expect(canonical).toContain("**Area:** `packages/mate-core`");
  });

  test("a multi-area delta yields one scalar repository and every Area in order", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(
      root,
      folder,
      "cap",
      `---
type: delta-spec
capability: cap
scopes:
  - repository: acme/product
    area: packages/api
  - repository: acme/product
    area: apps/storefront
---`,
    );
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");

    const canonical = await readCanonical(root, "cap");
    expect(canonical).toContain("repository: acme/product");
    expect(canonical).toContain("areas: [packages/api, apps/storefront]");
    expect(canonical).not.toContain("scopes:");
  });

  test("uses the archived mate-v1 schema when the current project default differs", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: spec-driven\n", "utf8");
    await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE);
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");

    expect(await readCanonical(root, "cap")).toContain("repository: acme/product");
  });

  test("skips non-mate-v1 archived schemas even when the project default is mate-v1", async () => {
    for (const schema of ["default", "spec-driven", "custom"]) {
      const root = await makeCompanion();
      const folder = "2026-08-06-probe";
      await fs.mkdir(path.join(root, "openspec"), { recursive: true });
      await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");
      await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE, `schema: ${schema}\n`);
      await seedCanonical(root, "cap", BARE_CANONICAL);

      await openspecFinisher(root).detectProduced("probe");

      expect(await readCanonical(root, "cap")).toBe(BARE_CANONICAL);
    }
  });

  test("skips missing or malformed archived schema metadata", async () => {
    for (const metadata of [null, "schema: [\n"]) {
      const root = await makeCompanion();
      const folder = "2026-08-06-probe";
      await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE, metadata);
      await seedCanonical(root, "cap", BARE_CANONICAL);

      await openspecFinisher(root).detectProduced("probe");

      expect(await readCanonical(root, "cap")).toBe(BARE_CANONICAL);
    }
  });

  test("a spec with existing frontmatter stays byte-identical", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE);
    const existing = `---\ntype: spec\ncapability: cap\nrepository: acme/other\nareas: [.]\ntags: [openspec/spec]\n---\n\n${BARE_CANONICAL}`;
    await seedCanonical(root, "cap", existing);

    await openspecFinisher(root).detectProduced("probe");

    expect(await readCanonical(root, "cap")).toBe(existing);
  });

  test("a multi-repository delta is skipped", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(
      root,
      folder,
      "cap",
      `---
type: delta-spec
capability: cap
scopes:
  - repository: acme/product
    area: packages/api
  - repository: acme/other
    area: packages/api
---`,
    );
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");

    expect(await readCanonical(root, "cap")).toBe(BARE_CANONICAL);
  });

  test("a delta without parseable scopes still gets type, capability, and tags", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(root, folder, "cap", "---\ntype: delta-spec\ncapability: cap\n---");
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");

    const canonical = await readCanonical(root, "cap");
    expect(canonical).toContain("type: spec");
    expect(canonical).toContain("capability: cap");
    expect(canonical).toContain("tags: [openspec/spec]");
    expect(canonical).not.toContain("repository:");
    expect(canonical).not.toContain("areas:");
  });

  test("reconciliation is idempotent across a resumed finish", async () => {
    const root = await makeCompanion();
    const folder = "2026-08-06-probe";
    await seedArchivedDelta(root, folder, "cap", SINGLE_SCOPE);
    await seedCanonical(root, "cap", BARE_CANONICAL);

    await openspecFinisher(root).detectProduced("probe");
    const once = await readCanonical(root, "cap");
    await openspecFinisher(root).detectProduced("probe");

    expect(await readCanonical(root, "cap")).toBe(once);
  });

  test("a change without delta specs reconciles nothing", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2026-08-06-probe");

    await expect(openspecFinisher(root).detectProduced("probe")).resolves.toEqual({
      anchorName: "2026-08-06-probe",
      commitPaths: ["openspec/changes/probe", "openspec/changes/archive/2026-08-06-probe"],
    });
  });

  test("a canonical spec absent from disk is left alone", async () => {
    const root = await makeCompanion();
    await seedArchivedDelta(root, "2026-08-06-probe", "cap", SINGLE_SCOPE);

    await openspecFinisher(root).detectProduced("probe");

    await expect(readCanonical(root, "cap")).rejects.toThrow();
  });

  test("reconciled specs are part of the finish commit paths", async () => {
    const root = await makeCompanion();
    await seedArchivedDelta(root, "2026-08-06-probe", "cap", SINGLE_SCOPE);
    await seedCanonical(root, "cap", BARE_CANONICAL);

    const produced = await openspecFinisher(root).detectProduced("probe");

    expect(produced?.commitPaths).toContain("openspec/specs/cap/spec.md");
  });
});
