import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { linkedRepositoryIdentities, repositorySources } from "./repositories";

let root: string;
let companion: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-workset-sources-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function link(paths: string[]): void {
  fs.writeFileSync(
    path.join(companion, ".mate", "config", "registry.yaml"),
    `repos:\n${paths.map((repo, index) => `  - id: repo-${index}\n    path: ${repo}\n`).join("")}`,
  );
}

function workingRepo(name: string, remote: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  return repo;
}

describe("repository sources", () => {
  test("a linked repository is cloned from its origin", async () => {
    link([workingRepo("web", "https://git.acme.test/acme/web.git")]);
    expect([...(await repositorySources(companion, {})).entries()]).toEqual([
      ["acme/web", "https://git.acme.test/acme/web.git"],
    ]);
  });

  test("a registry path missing here falls back to the configured repositories", async () => {
    link([path.join(root, "host-only", "web")]);
    const sources = await repositorySources(companion, {
      MATE_FACTORY_REPOSITORIES:
        "https://git.acme.test/acme/web.git,git@git.acme.test:acme/api.git",
    });
    expect(sources.get("acme/web")).toBe("https://git.acme.test/acme/web.git");
    expect(sources.get("acme/api")).toBe("git@git.acme.test:acme/api.git");
  });

  test("a linked origin wins over a configured URL for the same repository", async () => {
    link([workingRepo("web", "git@git.acme.test:acme/web.git")]);
    const sources = await repositorySources(companion, {
      MATE_FACTORY_REPOSITORIES: "https://mirror.acme.test/acme/web.git",
    });
    expect(sources.get("acme/web")).toBe("git@git.acme.test:acme/web.git");
  });

  test("names are offered sorted, and a companion without a registry offers the configured ones", async () => {
    expect(
      await linkedRepositoryIdentities(companion, {
        MATE_FACTORY_REPOSITORIES:
          "https://git.acme.test/acme/web.git, https://git.acme.test/acme/api.git",
      }),
    ).toEqual(["acme/api", "acme/web"]);
  });
});
