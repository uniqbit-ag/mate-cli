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
const conciseReportingPolicy =
  "When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision.";
const jsdocBoundary = "Apply this same preference to JSDoc.";

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
    expect(parsed.version).toBe(5);

    const dottedVersion = parse(raw.replace("version: 5", "version: 5.1")) as {
      version?: unknown;
    };
    expect(isValidSchemaVersion(dottedVersion.version)).toBe(false);
  });

  test("puts explore first and blocks proposal until its brief exists", async () => {
    const { parsed } = await readSchema();
    const explore = artifact(parsed, "explore");
    const proposal = artifact(parsed, "proposal");

    expect(explore.generates).toBe("explore-brief.md");
    expect(explore.requires).toEqual([]);
    expect(proposal.requires).toEqual(["explore"]);

    const completed = new Set<string>();
    expect(proposal.requires.every((dependency) => completed.has(dependency))).toBe(false);
    completed.add("explore");
    expect(proposal.requires.every((dependency) => completed.has(dependency))).toBe(true);
  });

  test("defines the exact exploration headings and adaptive question guidance", async () => {
    const { parsed } = await readSchema();
    const explore = artifact(parsed, "explore");
    const brief = await fs.readFile(path.join(templatesPath, "explore-brief.md"), "utf8");

    expect(brief).toContain("type: change-exploration");
    expect(brief).toContain("schema: mate-v1");
    expect(brief).toMatch(/^## Problem\n/m);
    expect(brief).toMatch(/^## Current State\n/m);
    expect(brief).toMatch(/^## Questions\n/m);
    expect(brief).toMatch(/^## Direction\n/m);
    expect(explore.instruction).toContain("one batch");
    expect(explore.instruction).toContain("roughly 3 questions");
    expect(explore.instruction).toContain("5 for medium-complexity changes");
    expect(explore.instruction).toContain("up to 10");
    expect(explore.instruction).toContain("Stop early");
  });

  test("keeps reporting and JSDoc concise without changing implementation style", async () => {
    const { raw } = await readSchema();

    expect(raw).toContain(conciseReportingPolicy);
    expect(raw).toContain(jsdocBoundary);
    expect(raw).not.toContain("smallest correct implementation");
  });

  test("documents normalized remote identities and repository-relative Areas", async () => {
    const { raw } = await readSchema();

    expect(raw).toContain("git@github.com:org/repository.git");
    expect(raw).toContain("https://github.com/org/repository.git");
    expect(raw).toContain("repository: org/repository");
    expect(raw).toContain("area: acme");
    expect(raw).toContain("area: .");
    expect(raw).toContain("local checkout directory basename");
    expect(raw).toContain("N/A");
  });

  test("uses package roots for monorepos and exact paths for non-monorepos", async () => {
    const { raw } = await readSchema();
    const proposal = await fs.readFile(path.join(templatesPath, "proposal.md"), "utf8");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");
    const design = await fs.readFile(path.join(templatesPath, "design.md"), "utf8");
    const tasks = await fs.readFile(path.join(templatesPath, "tasks.md"), "utf8");

    expect(raw).toContain("area: acme");
    expect(raw).toContain("packages/api");
    expect(raw).toContain("org/other");
    expect(raw).toContain("not `acme/src/sub-1/sub-2`");
    expect(raw).toContain("acme/src");
    expect(raw).toContain("acme` Area");
    expect(raw).not.toContain("area: acme/src");
    expect(raw).toContain("A non-monorepo repository may use exact subpaths such as `docs`");
    expect(raw).toContain("never from the capability name");
    expect(raw).toContain("area: apps/storefront");
    expect(raw).not.toContain("area: apps/storefront/src");
    expect(raw).toContain(
      "the directory containing that package's manifest (`package.json`, `Cargo.toml`, `go.mod`, etc.) nearest the affected path",
    );
    expect(raw).toContain("not `acme/src/sub-1/sub-2` or `apps/storefront/src/features/checkout`");
    expect(raw).toContain("collapse `apps/storefront/src/features/checkout` to `apps/storefront`");
    expect(proposal).toContain("scopes:");
    expect(proposal).toContain("type: change-proposal");
    expect(proposal).toContain("status: active");
    expect(proposal).toContain("tags: [openspec/change, openspec/proposal]");
    expect(proposal).toContain("repository: org/repository");
    expect(proposal).toContain("area: .");
    expect(spec).toContain("type: delta-spec");
    expect(spec).toContain("capability: <capability>");
    expect(spec).toContain("tags: [openspec/change, openspec/spec, openspec/delta]");
    expect(spec).toContain("always, even when there is only one");
    expect(spec).toContain("**Area:** `packages/ui`");
    expect(spec).toContain("Every scopes entry names the same repository");
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
    const { raw, parsed } = await readSchema();
    const specs = artifact(parsed, "specs");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");

    expect(specs.instruction).toContain(
      "EVERY requirement MUST carry an `**Area:**` marker naming the Areas it binds",
    );
    expect(specs.instruction).toContain(
      "including a spec whose frontmatter names only one Area and a requirement that binds all of them",
    );
    /** Unconditional marking is what survives archive discarding frontmatter. */
    expect(specs.instruction).toContain(
      "survives archive creating a new main spec (which discards frontmatter but copies requirement blocks verbatim)",
    );
    expect(specs.instruction).toContain(
      "a spec that later gains an Area needs no edit to its existing requirements",
    );
    expect(specs.instruction).not.toContain("MUST NOT carry an `**Area:**` marker");
    expect(spec).toContain("EVERY requirement carries an **Area:** marker");
    expect(specs.instruction).toContain("**Area:** `acme`, `packages/api`");
    expect(raw).toContain(
      "Add an `**Area:**` marker to every requirement that lacks one, including in a spec whose frontmatter names only one Area",
    );
  });

  test("defaults new capabilities to one package root without giving names scope authority", async () => {
    const { parsed } = await readSchema();
    const specs = artifact(parsed, "specs");
    const proposal = artifact(parsed, "proposal");

    expect(specs.instruction).toContain(
      "Default a new capability to a single scope entry for the owning package root",
    );
    expect(specs.instruction).toContain(
      "write two capability specs rather than one spec with two Areas",
    );
    expect(proposal.instruction).toContain("Default a new capability to one package root");
    expect(specs.instruction).toContain("carry no authority over scope");
    expect(specs.instruction).toContain(
      "A descriptive name aligned with its package root is permitted",
    );
    expect(proposal.instruction).toContain(
      "a descriptive name aligned with its package root is permitted",
    );
  });

  test("binds every spec to exactly one repository and drops Repository markers", async () => {
    const { raw, parsed } = await readSchema();
    const specs = artifact(parsed, "specs");
    const proposal = artifact(parsed, "proposal");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");

    expect(specs.instruction).toContain("A spec MUST name exactly one repository");
    expect(specs.instruction).toContain(
      "requirement-level `**Repository:**` markers do not exist in this model",
    );
    expect(specs.instruction).toContain(
      "Cross-repository work is specified as one capability per repository",
    );
    /** The single-repository rule binds each spec, never the change. */
    expect(specs.instruction).toContain("this rule binds each spec, not the change");
    expect(proposal.instruction).toContain(
      "A change MAY declare scopes in several repositories, but each capability spec names exactly one",
    );
    expect(spec).toContain("no **Repository:** marker is ever used");
    expect(spec).not.toContain("A **Repository:** marker is allowed only when");
    expect(raw).not.toContain("Prefer single-repository specs");
    expect(raw).not.toContain("ONLY when the spec's frontmatter names more than one repository");
    expect(raw).toContain("Remove every requirement-level `**Repository:**` marker");
  });

  test("does not define separate repository and Area arrays", async () => {
    const { raw } = await readSchema();

    expect(raw).not.toMatch(/^\s*repositories:\s*$/m);
    expect(raw).not.toMatch(/^\s*areas:\s*$/m);
    expect(raw).toContain("never use separate parallel `repositories` and `areas` arrays");
  });
});
