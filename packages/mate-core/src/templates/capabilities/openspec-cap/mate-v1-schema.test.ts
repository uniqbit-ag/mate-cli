import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

type Artifact = {
  id: string;
  generates: string;
  requires: string[];
  instruction: string;
};

type MateSchema = {
  name: string;
  version: number;
  artifacts: Artifact[];
};

const profilePath = path.join(import.meta.dir, "mate-v1");
const schemaPath = path.join(profilePath, "schema.yaml");
const templatesPath = path.join(profilePath, "templates");
async function readSchema(): Promise<{ raw: string; parsed: MateSchema }> {
  const raw = await fs.readFile(schemaPath, "utf8");
  return { raw, parsed: parse(raw) as MateSchema };
}

function artifact(schema: MateSchema, id: string): Artifact {
  const result = schema.artifacts.find((entry) => entry.id === id);
  if (!result) throw new Error(`Missing artifact: ${id}`);
  return result;
}

function isValidSchemaVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

describe("mate-v1 schema", () => {
  test("uses profile mate-v1 with an integer version and rejects dotted versions", async () => {
    const { raw, parsed } = await readSchema();

    expect(parsed.name).toBe("mate-v1");
    expect(isValidSchemaVersion(parsed.version)).toBe(true);
    expect(parsed.version).toBe(8);

    const dottedVersion = parse(raw.replace("version: 8", "version: 8.1")) as {
      version?: unknown;
    };
    expect(isValidSchemaVersion(dottedVersion.version)).toBe(false);
  });

  test("starts at proposal and preserves downstream stage dependencies", async () => {
    const { parsed } = await readSchema();
    const proposal = artifact(parsed, "proposal");
    const design = artifact(parsed, "design");
    const tasks = artifact(parsed, "tasks");

    expect(parsed.artifacts.map((entry) => entry.id)).toEqual([
      "proposal",
      "specs",
      "design",
      "tasks",
    ]);
    expect(proposal.requires).toEqual([]);
    expect(design.requires).toEqual(["proposal"]);
    expect(tasks.requires).toEqual(["specs", "design"]);
  });

  test("keeps companion-wide style guidance out of the workflow schema", async () => {
    const { raw } = await readSchema();

    expect(raw).not.toContain("sacrifice grammar");
    expect(raw).not.toContain("Code comments: JSDoc format only");
  });

  test("references the shared scope and frontmatter conventions", async () => {
    const { raw } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );

    expect(raw).toContain("openspec/mate-conventions.yaml");
    expect((parse(conventions) as { name: string }).name).toBe("mate-openspec-conventions");
    expect(conventions).toContain("git@github.com:org/repository.git");
    expect(conventions).toContain("https://github.com/org/repository.git");
    expect(conventions).toContain("local checkout basename");
    expect(conventions).toContain("N/A");
  });

  test("uses package roots for monorepos and exact paths for non-monorepos", async () => {
    const { raw } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );
    const proposal = await fs.readFile(path.join(templatesPath, "proposal.md"), "utf8");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");
    const design = await fs.readFile(path.join(templatesPath, "design.md"), "utf8");
    const tasks = await fs.readFile(path.join(templatesPath, "tasks.md"), "utf8");

    expect(conventions).toContain("one owning package root");
    expect(conventions).toContain("package.json, Cargo.toml, go.mod");
    expect(conventions).toContain("repository/Area pair");
    expect(conventions).toContain("Area identity comes only from frontmatter");
    expect(conventions).toContain("owning workspace or package root");
    expect(raw).toContain("Specs are always flat at `specs/<capability>/spec.md`");
    expect(proposal).toContain("scopes:");
    expect(proposal).toContain("type: change-proposal");
    expect(proposal).toContain("status: active");
    expect(proposal).toContain("tags: [openspec/change, openspec/proposal]");
    expect(proposal).toContain("repository: org/repository");
    expect(proposal).toContain("area: .");
    expect(spec).toContain("type: delta-spec");
    expect(spec).toContain("capability: <capability>");
    expect(spec).toContain("tags: [openspec/change, openspec/spec, openspec/delta]");
    expect(spec).toContain("EVERY requirement carries an **Area:** marker");
    expect(spec).toContain("**Area:** `packages/ui`");
    expect(design).toContain("scopes:");
    expect(tasks).toContain("scopes:");
    expect(design).toContain("type: change-design");
    expect(design).toContain("schema: mate-v1");
    expect(tasks).toContain("type: change-tasks");
    expect(tasks).toContain("schema: mate-v1");
  });

  test("guides delta Purpose for new capabilities in template and specs instruction", async () => {
    const { parsed } = await readSchema();
    const specs = artifact(parsed, "specs");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");

    expect(spec).toMatch(/^## Purpose\n/m);
    expect(spec.indexOf("## Purpose")).toBeLessThan(spec.indexOf("## ADDED Requirements"));
    expect(spec).toContain("New capabilities only");
    expect(spec).toContain("50+ characters");
    expect(spec).toContain("Delete this section for an existing capability");
    expect(specs.instruction).toContain("start the delta spec body with a `## Purpose` section");
    expect(specs.instruction).toContain("50+ characters");
    expect(specs.instruction).toContain("Archive copies it into the main spec it creates");
    expect(specs.instruction).toContain("TBD ... Update Purpose after archive.");
    expect(specs.instruction).toContain(
      "Do NOT add `## Purpose` to a delta for an existing capability",
    );
  });

  test("requires an Area marker on every requirement unconditionally", async () => {
    const { parsed } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );
    const specs = artifact(parsed, "specs");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");

    expect(specs.instruction).toContain(
      "EVERY requirement MUST carry an `**Area:**` marker naming the Areas it binds",
    );
    expect(specs.instruction).not.toContain("MUST NOT carry an `**Area:**` marker");
    expect(spec).toContain("EVERY requirement carries an **Area:** marker");
    expect(conventions).toContain("Every requirement MUST carry an Area marker");
    expect(conventions).toContain("copies requirement blocks but discards delta frontmatter");
  });

  test("defaults new capabilities to one package root without giving names scope authority", async () => {
    const { parsed } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );
    const specs = artifact(parsed, "specs");

    expect(conventions).toContain("Default a new capability to one owning package root");
    expect(conventions).toContain("one capability per repository");
    expect(conventions).toContain("folder names are descriptive and have no scope authority");
    expect(specs.instruction).toContain("Specs are always flat at `specs/<capability>/spec.md`");
  });

  test("binds every spec to exactly one repository and drops Repository markers", async () => {
    await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");

    expect(conventions).toContain("A capability spec names exactly one repository");
    expect(conventions).toContain("Never use separate repositories and areas arrays");
    expect(conventions).toContain("delta-only change and delta tags");
    expect(spec).toContain("No **Repository:** marker is ever used");
  });

  test("does not define separate repository and Area arrays", async () => {
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );

    expect(conventions).toContain("Never use separate repositories and areas arrays");
  });

  test("defines flat canonical spec frontmatter distinct from the delta block", async () => {
    const { parsed } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );
    const specs = artifact(parsed, "specs");

    expect(conventions).toContain("A canonical spec uses flat frontmatter");
    expect(conventions).toContain("scalar repository, areas list");
    expect(conventions).toContain("tags: [openspec/spec]");
    expect(conventions).toContain("nested scopes list");
    expect(specs.instruction).toContain("Canonical-spec shape, delta-to-canonical projection");
  });

  test("keeps paired scopes on change artifacts and forbids scopes on canonical specs", async () => {
    const { raw } = await readSchema();
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );

    expect(raw).toContain("Record the paired scope as `scopes` metadata");
    expect(conventions).toContain("Change frontmatter uses paired scopes");
    expect(conventions).toContain("Canonical frontmatter uses flat repository and areas scalars");
  });

  test("specifies the delta-to-canonical projection including its failure case", async () => {
    const conventions = await fs.readFile(
      path.join(profilePath, "..", "openspec-conventions.yaml"),
      "utf8",
    );

    expect(conventions).toContain("all its scope entries MUST name the same repository");
    expect(conventions).toContain("distinct Areas as areas in their original order");
    expect(conventions).toContain("split the capability before archive");
  });
});
