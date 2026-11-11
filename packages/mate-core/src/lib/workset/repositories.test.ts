import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  linkedRepositoryCatalog,
  linkedRepositoryIdentities,
  repositorySources,
} from "./repositories";

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
  fs.mkdirSync(repo, { recursive: true });
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

  test("an Umbrella Repository offers its children, also one cloned after linking", async () => {
    workingRepo(path.join("acme", "web"), "https://git.acme.test/acme/web.git");
    workingRepo(path.join("acme", "api"), "git@git.acme.test:acme/api.git");
    link([path.join(root, "acme")]);
    expect(await linkedRepositoryIdentities(companion, {})).toEqual(["acme/api", "acme/web"]);
    workingRepo(path.join("acme", "docs"), "git@git.acme.test:acme/docs.git");
    expect(await linkedRepositoryIdentities(companion, {})).toEqual([
      "acme/api",
      "acme/docs",
      "acme/web",
    ]);
  });

  test("names are offered sorted, and a companion without a registry offers the configured ones", async () => {
    expect(
      await linkedRepositoryIdentities(companion, {
        MATE_FACTORY_REPOSITORIES:
          "https://git.acme.test/acme/web.git, https://git.acme.test/acme/api.git",
      }),
    ).toEqual(["acme/api", "acme/web"]);
  });

  test("the catalog maps each linked registry ID to its identity", async () => {
    link([workingRepo("web", "https://git.acme.test/acme/web.git")]);
    const catalog = await linkedRepositoryCatalog(companion, {
      MATE_FACTORY_REPOSITORIES: "https://git.acme.test/acme/api.git",
    });
    expect(catalog.identities).toEqual(["acme/api", "acme/web"]);
    expect([...catalog.aliases.entries()]).toEqual([["repo-0", "acme/web"]]);
  });

  test("the catalog gives each repository its host/org token key and omits one with no organization", async () => {
    link([workingRepo("web", "https://git.acme.test/acme/web.git")]);
    const catalog = await linkedRepositoryCatalog(companion, {
      MATE_FACTORY_REPOSITORIES: "https://github.test/other/api.git,https://git.acme.test/solo.git",
    });
    expect([...catalog.keys.entries()].toSorted()).toEqual([
      ["acme/web", "git.acme.test/acme"],
      ["other/api", "github.test/other"],
    ]);
    expect(JSON.stringify([...catalog.keys])).not.toMatch(/token|secret/i);
  });

  test("the catalog gives an SSH remote no token key: a token never applies to it", async () => {
    link([workingRepo("web", "git@git.acme.test:acme/web.git")]);
    const catalog = await linkedRepositoryCatalog(companion, {});
    expect(catalog.identities).toEqual(["acme/web"]);
    expect([...catalog.keys]).toEqual([]);
  });

  test("the catalog offers an Umbrella Repository's children but maps its ID to none", async () => {
    workingRepo(path.join("acme", "web"), "https://git.acme.test/acme/web.git");
    workingRepo(path.join("acme", "api"), "git@git.acme.test:acme/api.git");
    link([path.join(root, "acme"), workingRepo("docs", "git@git.acme.test:acme/docs.git")]);
    const catalog = await linkedRepositoryCatalog(companion, {});
    expect(catalog.identities).toEqual(["acme/api", "acme/docs", "acme/web"]);
    expect([...catalog.aliases.entries()]).toEqual([["repo-1", "acme/docs"]]);
  });
});
