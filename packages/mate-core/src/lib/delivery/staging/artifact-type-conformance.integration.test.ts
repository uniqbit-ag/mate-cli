import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  makeStagingFixture,
  mergedYaml,
  showAt,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { recordDir, sourceDir, type ArtifactType } from "./artifact-type";
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
