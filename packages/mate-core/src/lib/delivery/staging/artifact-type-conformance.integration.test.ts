import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  makeStagingFixture,
  mergedYaml,
  showAt,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { changeNames, locate } from "../../change-layout";
import { parseWorkflow } from "../../workflow/declaration";
import { recordDir, sourceDir, type ArtifactType } from "./artifact-type";
import { declaredArtifactType } from "./declared-type";
import { openspecArtifactType } from "./openspec-type";
import { publishSubmitted } from "./publish";
import { submitGroups, writeSubmissionState } from "./submit";

const TIMEOUT = 60_000;
const INBOX = "mate/inbox";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** A second artifact type: each change's note is appended to `notes/index.md` at publication. */
const NOTES: ArtifactType = {
  name: "acme-notes",
  source: "notes",
  archiveRoot: "notes-archive",
  deliveryFile: "delivery.yaml",
  isRecordId: (id) => /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id),
  recordName: (id) => id.slice(11),
  check: async (dir, name) =>
    fs.existsSync(path.join(sourceDir(dir, NOTES, name), "note.md")) ? null : "no note.md",
  async apply(dir, name) {
    const source = sourceDir(dir, NOTES, name);
    const record = `2026-11-15-${name}`;
    await fsp.appendFile(
      path.join(dir, "notes", "index.md"),
      await fsp.readFile(path.join(source, "note.md"), "utf8"),
    );
    await fsp.mkdir(recordDir(dir, NOTES), { recursive: true });
    await fsp.rename(source, recordDir(dir, NOTES, record));
    return { ok: true, record };
  },
  validate: async (_dir, files) =>
    files.includes("notes/index.md") ? null : { path: "notes/index.md", detail: "unchanged" },
};

/** Submits change `name` through the core: its check, `state: submitted`, the group push. */
async function submit(fixture: StagingFixture, companion: string, name: string): Promise<void> {
  expect(await NOTES.check(companion, name)).toBeNull();
  await writeSubmissionState(sourceDir(companion, NOTES, name), name, "submitted");
  const [submission] = await submitGroups(companion, [name], {
    artifactType: NOTES,
    tmpRoot: fixture.root,
    stateHome: fixture.root,
  });
  expect(submission).toMatchObject({ group: "acme_product/workset/acme-notes", status: "pushed" });
}

/** Publishes change `name`'s Delivery Group through the core's publication. */
async function publish(fixture: StagingFixture, companion: string, name: string): Promise<void> {
  const result = await publishSubmitted(companion, name, {
    artifactType: NOTES,
    tmpRoot: fixture.root,
  });
  expect(result).toMatchObject({
    status: "ok",
    group: "acme_product/workset/acme-notes",
    records: [`2026-11-15-${name}`],
  });
}

describe("artifact type conformance", () => {
  test(
    "another type submits and publishes through the same core without OpenSpec",
    async () => {
      const fixture = await makeStagingFixture();
      fixtures.push(fixture);
      const companion = fixture.clone("acme-companion");
      const source = sourceDir(companion, NOTES, "acme-release");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "note.md"), "- acme release notes\n");
      fs.writeFileSync(
        path.join(source, NOTES.deliveryFile),
        `version: 1\nchange: acme-release\ndeliveries:\n  - repository: acme/product\n    branch: workset/acme-notes\n${mergedYaml}`,
      );
      fs.mkdirSync(path.join(companion, "notes"), { recursive: true });
      fs.writeFileSync(path.join(companion, "notes", "index.md"), "");
      git(companion, "add", "notes/index.md");
      git(companion, "commit", "-qm", "notes index");
      git(companion, "push", "-q", "origin", "HEAD");

      await submit(fixture, companion, "acme-release");

      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).toBe(
        "- acme release notes\n",
      );
      expect(showAt(fixture.remote, "main", "notes/acme-release/note.md")).toBeNull();

      await publish(fixture, companion, "acme-release");

      expect(showAt(fixture.remote, "main", "notes/index.md")).toBe("- acme release notes\n");
      // The inbox is emptied once the default branch holds the archive.
      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).toBeNull();
      expect(
        showAt(fixture.remote, "main", "notes-archive/2026-11-15-acme-release/note.md"),
      ).not.toBeNull();
      expect(
        git(
          fixture.remote,
          "log",
          "-1",
          "--format=%(trailers:key=Mate-Artifact,valueonly)",
          "main",
        ).trim(),
      ).toBe("acme-notes/2026-11-15-acme-release");
      // The checkout took the published commit.
      expect(git(companion, "rev-parse", "HEAD")).toBe(git(fixture.remote, "rev-parse", "main"));
    },
    TIMEOUT,
  );
});

describe("lookup and reads of both adapters", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function companionWith(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-adapters-"));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    return root;
  }

  function declaredNotes(): ArtifactType {
    const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    archive: notes-history/{id}/
    published: [notes/index.md]
    reviews: { brief: brief.md, plan: plan.md }
    publish:
      apply: { run: "true" }
stages:
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
    if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
    return declaredArtifactType(verdict.workflow.artifacts[0]!);
  }

  test("the built-in type: changes, archive ids, its plan and the artifacts it has", async () => {
    const type = openspecArtifactType();
    const root = companionWith({
      "openspec/changes/acme-fix/tasks.md": "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n",
      "openspec/changes/acme-fix/proposal.md": "# Acme\n",
      "openspec/changes/archive/2026-01-02-acme-old/proposal.md": "# Acme\n",
    });
    const dir = sourceDir(root, type, "acme-fix");

    expect(await changeNames(root, type)).toEqual(["acme-fix"]);
    expect(await locate(root, type, "acme-fix")).toEqual({ dir, archived: false });
    expect(await locate(root, type, "2026-01-02-acme-old")).toEqual({
      dir: recordDir(root, type, "2026-01-02-acme-old"),
      archived: true,
    });
    expect(await locate(root, type, "acme-new")).toEqual({ missing: "openspec/changes/acme-new/" });
    expect(await type.plan!(dir)).toEqual({ totalTasks: 2, completedTasks: 1 });
    expect(await type.reviews!(dir)).toEqual([
      { id: "proposal", file: "proposal.md" },
      { id: "tasks", file: "tasks.md" },
    ]);
  });

  test("a declared type: changes, archive ids, no plan, and every declared review", async () => {
    const type = declaredNotes();
    const root = companionWith({
      "notes/acme-glossary/brief.md": "# Acme\n",
      "notes-history/2026-01-02-acme-old/brief.md": "# Acme\n",
    });
    const dir = sourceDir(root, type, "acme-glossary");

    expect(await changeNames(root, type)).toEqual(["acme-glossary"]);
    expect(await locate(root, type, "acme-glossary")).toEqual({ dir, archived: false });
    expect(await locate(root, type, "2026-01-02-acme-old")).toEqual({
      dir: recordDir(root, type, "2026-01-02-acme-old"),
      archived: true,
    });
    expect(await locate(root, type, "acme-new")).toEqual({ missing: "notes/acme-new/" });
    expect(type.plan).toBeUndefined();
    expect(await type.reviews!(dir)).toEqual([
      { id: "brief", file: "brief.md" },
      { id: "plan", file: "plan.md" },
    ]);
  });
});
