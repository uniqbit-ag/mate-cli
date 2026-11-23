import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseWorkflow } from "../../workflow/declaration";
import { declaredArtifactType, maskSecrets } from "./declared-type";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acme-declared-type-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function notesType(hooks: { check?: string; apply?: string; validate?: string }) {
  const hook = (run: string | undefined, key: string) =>
    run === undefined ? "" : `      ${key}: { run: ${JSON.stringify(run)} }\n`;
  const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: ["notes/*.md"]
    submit:
${hook(hooks.check ?? "true", "check")}    publish:
${hook(hooks.apply ?? "true", "apply")}${hook(hooks.validate, "validate")}stages:
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return declaredArtifactType(verdict.workflow.artifacts[0]!, { trusted: async () => true });
}

const exists = (file: string) =>
  fs.stat(path.join(dir, file)).then(
    () => true,
    () => false,
  );

describe("a declared type's run: command", () => {
  test("never runs a change name as shell code", async () => {
    const name = "x$(touch acme-pwned)'`touch acme-pwned`";
    await fs.mkdir(path.join(dir, "notes", name), { recursive: true });

    // Unquoted, and inside a here-document, where the shell expands `$(…)` in spliced text.
    for (const check of ["printf %s {change} > acme-out", "cat > acme-out <<EOF\n{change}\nEOF"]) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      expect(await notesType({ check }).check(dir, name)).toBeNull();
      // oxlint-disable-next-line no-await-in-loop -- same
      expect(await fs.readFile(path.join(dir, "acme-out"), "utf8")).toContain(`notes/${name}`);
    }
    expect(await exists("acme-pwned")).toBe(false);
  });

  test("passes a file that looks like an option as a path", async () => {
    const type = notesType({ validate: 'printf "%s\\n" {files} > acme-out' });

    expect(await type.validate!(dir, ["notes/--force.md", "notes/a.md"])).toBeNull();

    expect(await fs.readFile(path.join(dir, "acme-out"), "utf8")).toBe(
      "notes/--force.md\nnotes/a.md\n",
    );
  });

  test("refuses a change name a command reads as an option", async () => {
    const type = notesType({ check: "touch acme-ran" });

    expect(await type.check(dir, "--all")).toContain("as an option");
    expect(await exists("acme-ran")).toBe(false);
  });

  test("masks secrets in a failure's output", async () => {
    const type = notesType({
      check: "echo 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx' >&2; exit 1",
    });

    const failure = await type.check(dir, "acme-release");

    expect(failure).toBe("GITHUB_TOKEN=***");
  });
});

describe("a declared type's apply", () => {
  test("deletes no folder through a symbolic link", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "acme-outside-"));
    try {
      await fs.mkdir(path.join(outside, "acme-release"));
      await fs.symlink(outside, path.join(dir, "notes"));
      const type = notesType({});

      const applied = await type.apply(dir, "acme-release");

      expect(applied).toMatchObject({ ok: false });
      expect(applied.ok ? "" : applied.detail).toContain("symbolic link");
      expect(await fs.stat(path.join(outside, "acme-release")).catch(() => null)).not.toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("a declared type's apply, with an archive", () => {
  test("never replaces an earlier record of the same id", async () => {
    const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    archive: notes-history/{id}/
    published: ["notes/*.md"]
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
    const type = declaredArtifactType(verdict.workflow.artifacts[0]!, {
      date: () => "2026-11-15",
      trusted: async () => true,
    });
    const earlier = path.join(dir, "notes-history", "2026-11-15-acme-release");
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(path.join(earlier, "note.md"), "earlier\n");
    await fs.mkdir(path.join(dir, "notes", "acme-release"), { recursive: true });

    const applied = await type.apply(dir, "acme-release");

    expect(applied).toMatchObject({ ok: false });
    expect(await fs.readFile(path.join(earlier, "note.md"), "utf8")).toBe("earlier\n");
    expect(await exists("notes/acme-release")).toBe(true);
  });
});

describe("maskSecrets", () => {
  test("masks assignments, headers, URL credentials and token shapes", () => {
    expect(maskSecrets("api_key: abc123")).toBe("api_key: ***");
    expect(maskSecrets("Authorization: Bearer abcdefghijkl")).toBe("Authorization: ***");
    expect(maskSecrets("fetch https://acme:hunter2@git.acme.test/x")).toBe(
      "fetch https://acme:***@git.acme.test/x",
    );
    expect(maskSecrets("found sk-abcdefghijklmnopqrstuvwxyz")).toBe("found ***");
    expect(maskSecrets("notes/acme.md: missing heading")).toBe("notes/acme.md: missing heading");
    expect(maskSecrets("password=p@ss!word")).toBe("password=***");
    // A location is no secret.
    expect(maskSecrets("invalid token: notes/acme.md:12")).toBe("invalid token: notes/acme.md:12");
  });
});
