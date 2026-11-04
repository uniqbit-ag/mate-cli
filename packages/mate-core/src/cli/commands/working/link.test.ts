import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LinkedRepository } from "../../../lib/orchestrator/types";
import { runWorkingLinkCommand } from "./link";

let root: string;
let companion: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-working-link-"));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "type: companion\n");
  process.exitCode = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function recorder() {
  const written: Array<[string, string, LinkedRepository, string]> = [];
  return {
    written,
    writeEntry: async (repo: string, comp: string, repository: LinkedRepository, source: string) =>
      void written.push([repo, comp, repository, source]),
  };
}

const git = (outputs: Record<string, string | null>) => async (_cwd: string, args: string[]) =>
  outputs[args.join(" ")] ?? null;

describe("mate working link", () => {
  test("writes the repo-local link named by the origin, never the companion registry", async () => {
    const { written, writeEntry } = recorder();
    await runWorkingLinkCommand(["--companion", companion, "--yes"], {
      cwd: "/var/lib/mate-factory/worktrees/acme-login/src",
      git: git({
        "rev-parse --show-toplevel": "/var/lib/mate-factory/worktrees/acme-login",
        "remote get-url origin": "https://git.acme.test/acme/web.git",
      }),
      writeEntry,
    });
    expect(written).toEqual([
      [
        "/var/lib/mate-factory/worktrees/acme-login",
        companion,
        { id: "web", path: "/var/lib/mate-factory/worktrees/acme-login" },
        "existing",
      ],
    ]);
    expect(fs.existsSync(path.join(companion, ".mate", "config", "registry.yaml"))).toBe(false);
  });

  test.each([
    [["--companion", "/x"], "usage"],
    [["--yes"], "usage"],
    [["--companion", "/x", "--yes", "--force"], "usage"],
  ])("refuses %j", async (argv) => {
    const { written, writeEntry } = recorder();
    await runWorkingLinkCommand(argv, { writeEntry });
    expect(process.exitCode).toBe(1);
    expect(written).toEqual([]);
  });

  test("refuses a path that is not a companion", async () => {
    const { written, writeEntry } = recorder();
    await runWorkingLinkCommand(["--companion", root, "--yes"], { writeEntry });
    expect(process.exitCode).toBe(1);
    expect(written).toEqual([]);
  });
});
