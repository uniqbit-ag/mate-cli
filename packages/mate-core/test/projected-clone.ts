import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stringify } from "yaml";

import { companionRegistryPath, globalConfigPath } from "../src/runtime/companion-registry-read";
import { companionFrameworkConfigPath } from "../src/runtime/policy";
import { writeProjectionPair } from "../src/runtime/projection";
import { repoLocalRegistryPath } from "../src/runtime/repo-local";
import { initRepo } from "./git-checkouts";

/** A real Git clone `acme-app` whose main worktree carries a trusted projection; runtime imports only. */
export interface ProjectedClone {
  root: string;
  companionPath: string;
  main: string;
  /** A plain session's environment: only `HOME`, which names the Mate configuration. */
  env: { HOME: string };
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** A Projection Root at `checkout` for `acme-app`, naming `repositoryPath`. */
export function project(clone: ProjectedClone, checkout: string, repositoryPath = checkout): void {
  writeFile(repoLocalRegistryPath(checkout), "companions: []\n");
  writeProjectionPair(checkout, {
    stamp: "stamp",
    projection: {
      version: "0.18.5",
      companionPath: clone.companionPath,
      repositoryPath,
      repositoryId: "acme-app",
      wrapperBinPath: "/install/mate/wrappers/bin",
      reactDoctorBinPath: "/install/mate/node_modules/.bin/react-doctor",
      graphifyOut: path.join(clone.companionPath, ".graphify", "acme-app"),
    },
  });
}

/** Replaces the companion registry's entries. */
export function link(
  clone: ProjectedClone,
  repos: Array<{ id: string; path: string; gitCommonDir?: string }>,
): void {
  writeFile(companionRegistryPath(clone.companionPath), stringify({ repos }));
}

/**
 * `acme-app` linked at its main worktree, with its shared Git folder, and
 * projected there; the companion is registered. `roots` collects the folder.
 */
export function projectedClone(roots: string[]): ProjectedClone {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-checkouts-")));
  roots.push(root);
  const home = path.join(root, "home");
  const clone: ProjectedClone = {
    root,
    companionPath: path.join(root, "acme"),
    main: initRepo(path.join(root, "acme-app")),
    env: { HOME: home },
  };
  writeFile(companionFrameworkConfigPath(clone.companionPath), "allowedAgents:\n  - claude\n");
  writeFile(
    globalConfigPath(home),
    stringify({ version: 1, companions: [{ path: clone.companionPath }] }),
  );
  link(clone, [{ id: "acme-app", path: clone.main, gitCommonDir: path.join(clone.main, ".git") }]);
  project(clone, clone.main);
  return clone;
}
