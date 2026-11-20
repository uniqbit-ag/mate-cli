import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  makeStagingFixture,
  mergedYaml,
  showAt,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { companionGit } from "../../../runtime/companion-git";
import { parseWorkflow } from "../../workflow/declaration";
import { locateTypedChange } from "../record-delivery";
import { sourceDir, type ArtifactType } from "./artifact-type";
import { declaredArtifactType } from "./declared-type";
import { publishSubmitted } from "./publish";
import { trailerRecordsAt } from "./refs";
import { submitGroups, takeSubmitted, writeSubmissionState } from "./submit";

const TIMEOUT = 60_000;
const INBOX = "mate/inbox";
const GROUP = "acme_product/workset/acme-notes";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

interface Declared {
  archive?: boolean;
  apply?: string;
}

/** The `acme-notes` type as a companion declares it: a note is appended to `notes/index.md`. */
function notesType({ archive = true, apply }: Declared = {}): ArtifactType {
  const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
${archive ? "    archive: notes-history/{id}/\n" : ""}    submit:
      check: { run: "test -f {change}/note.md" }
    publish:
      apply: { run: ${JSON.stringify(apply ?? "cat {change}/note.md >> notes/index.md")} }
      validate: { run: "grep -q acme {files}" }
stages:
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return declaredArtifactType(verdict.workflow.artifacts[0]!, {
    date: () => "2026-11-15",
    trusted: async () => true,
  });
}

/** A companion clone holding `notes/index.md` and the change `acme-release`, merged. */
async function companionWith(
  type: ArtifactType,
): Promise<{ fixture: StagingFixture; dir: string }> {
  const fixture = await makeStagingFixture();
  fixtures.push(fixture);
  const dir = fixture.clone("acme-companion");
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", "index.md"), "");
  git(dir, "add", "notes/index.md");
  git(dir, "commit", "-qm", "notes index");
  git(dir, "push", "-q", "origin", "HEAD");
  const source = sourceDir(dir, type, "acme-release");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "note.md"), "- acme release notes\n");
  fs.writeFileSync(
    path.join(source, type.deliveryFile),
    `version: 1\nchange: acme-release\ndeliveries:\n  - repository: acme/product\n    branch: workset/acme-notes\n${mergedYaml}`,
  );
  return { fixture, dir };
}

async function submit(fixture: StagingFixture, dir: string, type: ArtifactType): Promise<void> {
  expect(await type.check(dir, "acme-release")).toBeNull();
  await writeSubmissionState(sourceDir(dir, type, "acme-release"), "acme-release", "submitted");
  const [submission] = await submitGroups(dir, ["acme-release"], {
    artifactType: type,
    tmpRoot: fixture.root,
    stateHome: fixture.root,
  });
  expect(submission).toMatchObject({ group: GROUP, status: "pushed" });
}

const trailers = (fixture: StagingFixture): string =>
  git(
    fixture.remote,
    "log",
    "-1",
    "--format=%(trailers:key=Mate-Artifact,valueonly)",
    "main",
  ).trim();

describe("a declared artifact type", () => {
  test(
    "is submitted, taken and published, its folder moved to the archive",
    async () => {
      const type = notesType();
      const { fixture, dir } = await companionWith(type);
      await submit(fixture, dir, type);
      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).toBe(
        "- acme release notes\n",
      );

      fs.rmSync(sourceDir(dir, type, "acme-release"), { recursive: true });
      const taken = await takeSubmitted(dir, "acme-release", {
        artifactType: type,
        tmpRoot: fixture.root,
        stateHome: fixture.root,
      });
      expect(taken.status).not.toBe("refused");
      expect(fs.existsSync(path.join(sourceDir(dir, type, "acme-release"), "note.md"))).toBe(true);

      const result = await publishSubmitted(dir, "acme-release", {
        artifactType: type,
        tmpRoot: fixture.root,
      });
      expect(result).toMatchObject({ status: "ok", records: ["2026-11-15-acme-release"] });
      expect(showAt(fixture.remote, "main", "notes/index.md")).toBe("- acme release notes\n");
      expect(
        showAt(fixture.remote, "main", "notes-history/2026-11-15-acme-release/note.md"),
      ).not.toBeNull();
      expect(showAt(fixture.remote, "main", "notes/acme-release/note.md")).toBeNull();
      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).toBeNull();
      expect(trailers(fixture)).toBe("acme-notes/2026-11-15-acme-release");
    },
    TIMEOUT,
  );

  test(
    "without an archive its folder is deleted and the trailer says it is published",
    async () => {
      const type = notesType({ archive: false });
      const { fixture, dir } = await companionWith(type);
      await submit(fixture, dir, type);

      const result = await publishSubmitted(dir, "acme-release", {
        artifactType: type,
        tmpRoot: fixture.root,
      });
      expect(result).toMatchObject({ status: "ok", records: ["2026-11-15-acme-release"] });
      expect(showAt(fixture.remote, "main", "notes/index.md")).toBe("- acme release notes\n");
      expect(showAt(fixture.remote, "main", "notes/acme-release/note.md")).toBeNull();
      // Clearing the inbox asks whether the change is published: only the trailer can tell.
      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).toBeNull();
      const records = await trailerRecordsAt(
        companionGit(fixture.remote, { prompt: "never" }),
        "main",
        type,
      );
      expect(records.map((record) => record.id)).toEqual(["2026-11-15-acme-release"]);
    },
    TIMEOUT,
  );

  test(
    "an apply that writes outside its paths publishes nothing",
    async () => {
      const type = notesType({
        apply: "cat {change}/note.md >> notes/index.md && echo changed > README.md",
      });
      const { fixture, dir } = await companionWith(type);
      await submit(fixture, dir, type);
      const before = git(fixture.remote, "rev-parse", "main");

      const result = await publishSubmitted(dir, "acme-release", {
        artifactType: type,
        tmpRoot: fixture.root,
      });
      expect(result.status).toBe("conflict");
      expect(result.message).toContain("README.md");
      expect(git(fixture.remote, "rev-parse", "main")).toBe(before);
      expect(showAt(fixture.remote, INBOX, "notes/acme-release/note.md")).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a failing check and a failing validation are reported",
    async () => {
      const type = notesType();
      const { dir } = await companionWith(type);
      fs.rmSync(path.join(sourceDir(dir, type, "acme-release"), "note.md"));
      expect(await type.check(dir, "acme-release")).toContain("test -f");
      fs.writeFileSync(path.join(dir, "notes", "index.md"), "nothing\n");
      expect(await type.validate!(dir, ["notes/index.md", "README.md"])).toMatchObject({
        path: "notes/index.md",
      });
      // No published file changed: nothing to validate.
      expect(await type.validate!(dir, ["README.md"])).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "its change folder is found through the type, a missing one by the expected path",
    async () => {
      const type = notesType();
      const { dir } = await companionWith(type);
      const environment = { companionPath: dir, artifactType: type };
      expect(await locateTypedChange(environment, "acme-release")).toEqual({
        dir: sourceDir(dir, type, "acme-release"),
        archived: false,
      });
      expect(await locateTypedChange(environment, "acme-glossary")).toEqual({
        path: "notes/acme-glossary/",
      });
      // An archive id resolves to its record, as for the built-in type.
      const record = path.join(dir, "notes-history", "2026-01-02-acme-glossary");
      fs.mkdirSync(record, { recursive: true });
      expect(await locateTypedChange(environment, "2026-01-02-acme-glossary")).toEqual({
        dir: record,
        archived: true,
      });
    },
    TIMEOUT,
  );
});
