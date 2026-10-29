import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyWarnings,
  archiveWarnings,
  declaredDependencies,
  deltaRequirementEdits,
  planningWarning,
} from "./overlap";

let companion: string;
const changes = () => path.join(companion, "openspec", "changes");

async function writeDelta(change: string, capability: string, body: string): Promise<void> {
  const dir = path.join(changes(), change, "specs", capability);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "spec.md"),
    `<!-- mate:delta\nchange: ${change}\n-->\n\n${body}`,
  );
}

async function writeArtifact(change: string, file: string, frontmatter: string): Promise<void> {
  await fs.mkdir(path.join(changes(), change), { recursive: true });
  await fs.writeFile(path.join(changes(), change, file), `---\n${frontmatter}\n---\n\n# x\n`);
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-overlap-"));
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

describe("deltaRequirementEdits", () => {
  test("collects MODIFIED and REMOVED requirement names, ignoring ADDED", async () => {
    await writeDelta(
      "a",
      "studio-dashboard",
      [
        "## ADDED Requirements",
        "### Requirement: New thing",
        "## MODIFIED Requirements",
        "### Requirement: Every prompt can be copied",
        "## REMOVED Requirements",
        "### Requirement: Old thing",
      ].join("\n"),
    );
    expect(await deltaRequirementEdits(path.join(changes(), "a"))).toEqual([
      {
        capability: "studio-dashboard",
        requirement: "Every prompt can be copied",
        operation: "MODIFIED",
      },
      { capability: "studio-dashboard", requirement: "Old thing", operation: "REMOVED" },
    ]);
  });
});

describe("declaredDependencies", () => {
  test("reads dependsOn from any artifact's frontmatter", async () => {
    await writeArtifact("b", "proposal.md", "type: change-proposal\ndependsOn: [a]");
    await writeArtifact("b", "tasks.md", "type: change-tasks\ndependsOn:\n  - c\n  - a");
    expect(await declaredDependencies(path.join(changes(), "b"))).toEqual(["a", "c"]);
  });
});

describe("archiveWarnings", () => {
  test("warns when another active change modifies the same requirement", async () => {
    await writeDelta("a", "studio-dashboard", "## MODIFIED Requirements\n### Requirement: R1\n");
    await writeDelta("b", "studio-dashboard", "## REMOVED Requirements\n### Requirement: R1\n");
    await writeDelta("c", "studio-dashboard", "## MODIFIED Requirements\n### Requirement: R2\n");
    await writeDelta("d", "other", "## MODIFIED Requirements\n### Requirement: R1\n");
    expect(await archiveWarnings(companion, "a")).toEqual([
      {
        kind: "overlap",
        change: "b",
        capability: "studio-dashboard",
        requirement: "R1",
        message:
          "b also changes studio-dashboard › R1; archiving b later will replace this change's version of that requirement.",
      },
    ]);
  });

  test("compares nested capabilities by their full path", async () => {
    await writeDelta("a", "identity/user-auth", "## MODIFIED Requirements\n### Requirement: R1\n");
    await writeDelta("b", "identity/user-auth", "## MODIFIED Requirements\n### Requirement: R1\n");
    await writeDelta("c", "identity/admin-auth", "## MODIFIED Requirements\n### Requirement: R1\n");
    expect(await archiveWarnings(companion, "a")).toEqual([
      {
        kind: "overlap",
        change: "b",
        capability: "identity/user-auth",
        requirement: "R1",
        message:
          "b also changes identity/user-auth › R1; archiving b later will replace this change's version of that requirement.",
      },
    ]);
  });

  test("names a declared dependency that is not archived yet", async () => {
    await writeArtifact("b", "proposal.md", "dependsOn: [a, done]");
    await fs.mkdir(path.join(changes(), "a"), { recursive: true });
    await fs.mkdir(path.join(changes(), "archive", "2026-10-01-done"), { recursive: true });
    expect(await archiveWarnings(companion, "b")).toEqual([
      {
        kind: "dependency",
        change: "a",
        message: "b depends on a, which is not archived yet; archive a first.",
      },
    ]);
  });

  test("a change without deltas or dependencies has no warnings", async () => {
    await fs.mkdir(path.join(changes(), "solo"), { recursive: true });
    expect(await archiveWarnings(companion, "solo")).toEqual([]);
  });
});

describe("applyWarnings", () => {
  test("warns only for dependencies neither archived nor fully implemented", async () => {
    await writeArtifact("x", "proposal.md", "dependsOn: [done, open, empty, missing, shipped]");
    await writeArtifact("done", "tasks.md", "type: change-tasks");
    await fs.appendFile(path.join(changes(), "done", "tasks.md"), "- [x] 1.1 a\n- [X] 1.2 b\n");
    await writeArtifact("open", "tasks.md", "type: change-tasks");
    await fs.appendFile(path.join(changes(), "open", "tasks.md"), "- [x] 1.1 a\n- [ ] 1.2 b\n");
    await writeArtifact("empty", "tasks.md", "type: change-tasks");
    await fs.mkdir(path.join(changes(), "archive", "2026-10-01-shipped"), { recursive: true });
    const warnings = await applyWarnings(companion, "x");
    expect(warnings.map((warning) => warning.change)).toEqual(["empty", "missing", "open"]);
    expect(warnings[0].message).toBe(
      "x depends on empty, which is not implemented yet; apply empty first.",
    );
  });
});

describe("planningWarning", () => {
  const status = (...artifacts: [string, string][]) =>
    JSON.stringify({
      schemaName: "mate-v1",
      artifacts: artifacts.map(([id, status]) => ({ id, status })),
    });

  test("names artifacts neither done nor skipped", () => {
    expect(
      planningWarning(
        "x",
        status(["proposal", "ready"], ["specs", "done"], ["design", "blocked"], ["tasks", "done"]),
      ),
    ).toEqual({
      kind: "incomplete-planning",
      change: "x",
      artifacts: ["proposal", "design"],
      message: "x is missing planning artifacts its schema requires: proposal, design.",
    });
  });

  test("done and skipped artifacts complete the planning", () => {
    expect(planningWarning("x", status(["specs", "skipped"], ["tasks", "done"]))).toBeNull();
  });

  test("another schema's ready artifacts may be conditional, so they yield no warning", () => {
    const specDriven = JSON.stringify({
      schemaName: "spec-driven",
      artifacts: [
        { id: "design", status: "ready" },
        { id: "tasks", status: "done" },
      ],
    });
    expect(planningWarning("x", specDriven)).toBeNull();
  });

  test("unparsable status yields no warning", () => {
    expect(planningWarning("x", "not json")).toBeNull();
    expect(
      planningWarning("x", JSON.stringify({ schemaName: "mate-v1", artifacts: "none" })),
    ).toBeNull();
    expect(planningWarning("x", "null")).toBeNull();
  });
});
