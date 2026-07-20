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
    expect(parsed.version).toBe(2);

    const dottedVersion = parse(raw.replace("version: 2", "version: 2.1")) as {
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

  test("documents normalized remote identities and repository-relative Areas", async () => {
    const { raw } = await readSchema();

    expect(raw).toContain("git@github.com:org/repository.git");
    expect(raw).toContain("https://github.com/org/repository.git");
    expect(raw).toContain("repository: org/repository");
    expect(raw).toContain("area: apps/web");
    expect(raw).toContain("area: .");
    expect(raw).toContain("local checkout directory basename");
    expect(raw).toContain("N/A");
  });

  test("preserves paired scopes for monorepos and multiple repositories", async () => {
    const { raw } = await readSchema();
    const proposal = await fs.readFile(path.join(templatesPath, "proposal.md"), "utf8");
    const spec = await fs.readFile(path.join(templatesPath, "spec.md"), "utf8");
    const design = await fs.readFile(path.join(templatesPath, "design.md"), "utf8");
    const tasks = await fs.readFile(path.join(templatesPath, "tasks.md"), "utf8");

    expect(raw).toContain("apps/web");
    expect(raw).toContain("packages/api");
    expect(raw).toContain("org/other");
    expect(raw).toContain("services/api");
    expect(raw).toContain(
      "Every requirement MUST include direct inline `**Repository:**` and `**Area:**`",
    );
    expect(proposal).toContain("scopes:");
    expect(proposal).toContain("type: change-proposal");
    expect(proposal).toContain("status: active");
    expect(proposal).toContain("tags: [openspec/change, openspec/proposal]");
    expect(proposal).toContain("repository: org/repository");
    expect(proposal).toContain("area: .");
    expect(spec).toContain("type: delta-spec");
    expect(spec).toContain("capability: <capability>");
    expect(spec).toContain("tags: [openspec/change, openspec/spec, openspec/delta]");
    expect(spec).toContain("**Repository:** `org/repository`");
    expect(spec).toContain("**Area:** `.`");
    expect(design).toContain("type: change-design");
    expect(design).toContain("schema: mate-v1");
    expect(tasks).toContain("type: change-tasks");
    expect(tasks).toContain("schema: mate-v1");
  });

  test("does not define separate repository and Area arrays", async () => {
    const { raw } = await readSchema();

    expect(raw).not.toMatch(/^\s*repositories:\s*$/m);
    expect(raw).not.toMatch(/^\s*areas:\s*$/m);
    expect(raw).toContain("never use separate parallel `repositories` and `areas` arrays");
  });
});
