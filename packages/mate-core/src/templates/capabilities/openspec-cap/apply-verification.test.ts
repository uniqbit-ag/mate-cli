import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

type MateSchema = {
  apply: { instruction: string };
};

const SCHEMAS = ["mate-v1", "mate-minimal"] as const;
const VERIFICATION_SKILL = "mate-react-doctor";

type Conventions = { rules: string; verification: string; skill_tagging: string };

async function readConventions(): Promise<Conventions> {
  const raw = await fs.readFile(path.join(import.meta.dir, "openspec-conventions.yaml"), "utf8");
  return parse(raw) as Conventions;
}

async function readSchemaRaw(name: string): Promise<string> {
  return fs.readFile(path.join(import.meta.dir, name, "schema.yaml"), "utf8");
}

describe("shared apply verification", () => {
  test("conventions declare a verification rule gated on the skill being available", async () => {
    const { verification } = await readConventions();

    expect(verification).toContain(VERIFICATION_SKILL);
    expect(verification).toContain("available");
    expect(verification).toContain(`[skill:${VERIFICATION_SKILL}]`);
    expect(verification).toContain("React code");
    expect(verification).toContain("- [ ] N.M");
  });

  test("conventions say not to verify twice when the tagged task is done", async () => {
    const { verification } = await readConventions();

    expect(verification).toContain("already checked");
  });

  test("conventions limit task skill tags to Companion Repository skills", async () => {
    const { skill_tagging: rule } = await readConventions();

    expect(rule).toContain("[skill:<name>]");
    expect(rule).toContain("installed in the Companion Repository");
    expect(rule).toContain("Before tagging, check");
    expect(rule).toContain("`.claude/skills/`");
    expect(rule).toContain("`.agents/skills/`");
    expect(rule).toContain("user-global");
    expect(rule).toContain("plugin (`<plugin>:<skill>`)");
    expect(rule).toContain("built-in");
    expect(rule).toContain("leave the task untagged");
  });

  for (const name of SCHEMAS) {
    test(`${name} does not name the verification skill`, async () => {
      expect(await readSchemaRaw(name)).not.toContain(VERIFICATION_SKILL);
    });

    test(`${name} apply instruction falls back to the shared verification rules`, async () => {
      const schema = parse(await readSchemaRaw(name)) as MateSchema;

      expect(schema.apply.instruction).toContain("verification rules");
      expect(schema.apply.instruction).toContain("openspec/mate-conventions.yaml");
    });
  }
});
