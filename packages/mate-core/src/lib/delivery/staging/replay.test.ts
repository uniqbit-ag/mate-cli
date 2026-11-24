import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { RunOpenSpec } from "../../openspec-cli";
import { openspecArtifactType } from "./openspec-type";
import {
  changedRequirements,
  deltaFailure,
  replayArchive,
  requirementBlocks,
  resolveRequirement,
} from "./replay";

describe("names reach OpenSpec as operands", () => {
  test("a name like an option follows `--` in archive and both validations", async () => {
    const calls: string[][] = [];
    const runner: RunOpenSpec = async (args) => {
      calls.push([...args]);
      return { code: 1, stdout: "", stderr: "" };
    };
    const dir = path.join(os.tmpdir(), "acme-missing");
    const type = openspecArtifactType(runner);
    await replayArchive(dir, "--acme", runner);
    await type.check(dir, "--acme");
    await type.validate(dir, ["openspec/specs/--acme/spec.md"]);
    expect(calls.map((args) => [args[0], ...args.slice(-2)])).toEqual([
      ["archive", "--", "--acme"],
      ["validate", "--", "--acme"],
      ["validate", "--", "--acme"],
    ]);
  });
});

describe("deltaFailure", () => {
  test("names the capability and requirement OpenSpec could not apply", () => {
    const output =
      'Specs to update:\n  acme-widget: update\nacme-widget MODIFIED failed for header "### Requirement: Widget renders" - not found\nAborted.';
    expect(deltaFailure(output)).toEqual({
      capability: "acme-widget",
      requirement: "Widget renders",
      reason: "not found",
    });
  });

  test("is null for any other failure", () => {
    expect(deltaFailure("Validation failed: proposal.md missing")).toBeNull();
  });
});

describe("requirementBlocks", () => {
  test("keeps each requirement with its scenarios up to the next heading", () => {
    const blocks = requirementBlocks(
      "# acme\n\n## Requirements\n### Requirement: One\nThe one SHALL work.\n\n#### Scenario: Works\n- **WHEN** used\n\n### Requirement: Two\nThe two SHALL work.\n\n## Notes\nNot a requirement.\n",
    );
    expect([...blocks.keys()]).toEqual(["One", "Two"]);
    expect(blocks.get("One")).toContain("#### Scenario: Works");
    expect(blocks.get("Two")).toBe("The two SHALL work.");
  });

  test("keeps a deeper heading inside the requirement", () => {
    const blocks = requirementBlocks(
      "# acme\n\n## Requirements\n### Requirement: One\nThe one SHALL work.\n\n### Notes\nAbout one.\n",
    );
    expect(blocks.get("One")).toBe("The one SHALL work.\n\n### Notes\nAbout one.");
  });
});

describe("changedRequirements", () => {
  test("lists modified, removed and renamed-from requirements, not added ones", () => {
    const delta = [
      "## ADDED Requirements",
      "### Requirement: Fresh",
      "## MODIFIED Requirements",
      "### Requirement: Changed",
      "## REMOVED Requirements",
      "### Requirement: Gone",
      "## RENAMED Requirements",
      "- FROM: `### Requirement: Old name`",
      "- TO: `### Requirement: New name`",
    ].join("\n");
    expect(changedRequirements(delta)).toEqual(["Changed", "Gone", "Old name"]);
  });
});

describe("resolveRequirement", () => {
  test("refuses a capability that leaves the change's specs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-resolve-"));
    try {
      const change = path.join(root, "change");
      const outside = path.join(root, "spec.md");
      const delta = "## MODIFIED Requirements\n\n### Requirement: Acme\nOld.\n";
      await fs.mkdir(change);
      await fs.writeFile(outside, delta);

      const refusal = await resolveRequirement(
        change,
        { capability: "../../acme/..", requirement: "Acme" },
        "New.",
      );
      expect(refusal).toContain("is no capability name");
      expect(await fs.readFile(outside, "utf8")).toBe(delta);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a body holding a heading that would end the requirement's block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-resolve-"));
    try {
      const file = path.join(root, "specs", "acme", "spec.md");
      const delta = "## MODIFIED Requirements\n\n### Requirement: Acme\nOld.\n";
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, delta);
      const part = { capability: "acme", requirement: "Acme" };

      for (const body of [
        "New.\n\n### Requirement: Other\nSneaked in.",
        "New.\n\n## REMOVED Requirements\n\n### Requirement: Other",
        "New.\n\n# Title",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one body at a time
        expect(await resolveRequirement(root, part, body)).toContain("heading");
        // oxlint-disable-next-line no-await-in-loop -- same body
        expect(await fs.readFile(file, "utf8")).toBe(delta);
      }

      // A deeper heading belongs to the block.
      expect(
        await resolveRequirement(root, part, "New.\n\n#### Scenario: Acme\n- **WHEN** x"),
      ).toBeNull();
      expect(await fs.readFile(file, "utf8")).toContain("#### Scenario: Acme");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
