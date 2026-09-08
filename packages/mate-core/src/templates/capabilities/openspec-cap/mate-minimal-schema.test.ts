import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

type Artifact = {
  id: string;
  description: string;
  requires: string[];
  instruction: string;
};

type MateSchema = {
  name: string;
  version: number;
  artifacts: Artifact[];
};

const profilePath = path.join(import.meta.dir, "mate-minimal");

async function readSchema(): Promise<MateSchema> {
  return parse(await fs.readFile(path.join(profilePath, "schema.yaml"), "utf8")) as MateSchema;
}

function artifact(schema: MateSchema, id: string): Artifact {
  const result = schema.artifacts.find((entry) => entry.id === id);
  if (!result) throw new Error(`Missing artifact: ${id}`);
  return result;
}

describe("mate-minimal schema", () => {
  test("defines the short, deliberately selected workflow", async () => {
    const schema = await readSchema();

    expect(schema.name).toBe("mate-minimal");
    expect(schema.version).toBe(2);
    expect(schema.artifacts.map((entry) => entry.id)).toEqual(["specs", "tasks"]);
    expect(artifact(schema, "specs").requires).toEqual([]);
    expect(artifact(schema, "tasks").requires).toEqual(["specs"]);
    expect(artifact(schema, "specs").instruction).toContain("not an optional subset of mate-v1");
    expect(artifact(schema, "specs").instruction).toContain("one repository and one Area");
  });

  test("uses OpenSpec delta headings around user-story content", async () => {
    const schema = await readSchema();
    const spec = await fs.readFile(path.join(profilePath, "templates", "spec.md"), "utf8");
    const instructions = artifact(schema, "specs").instruction;

    expect(spec).toContain("## ADDED Requirements");
    expect(spec).toContain("### Requirement:");
    expect(spec).toContain("As a <!-- role -->, I want");
    expect(spec).toContain("The system MUST support");
    expect(spec).toContain("#### Acceptance Criteria");
    expect(spec).not.toContain("## ADDED User Stories");
    expect(instructions).toContain("`### User Story:` is ignored");
    expect(instructions).toContain("`openspec validate --strict`");
  });

  test("keeps companion-wide style guidance out of the profile", async () => {
    const schema = await readSchema();

    expect(schema.artifacts[0].instruction).not.toContain("sacrifice grammar");
    expect(schema.artifacts[1].instruction).not.toContain("Code comments: JSDoc format only");
  });
});
