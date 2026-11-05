import fs from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import { createTempDir } from "../../../test/fixtures";
import { GlobalConfigStore } from "../src/lib/orchestrator/global-config-store";
import { companionRegistryPath } from "../src/lib/orchestrator/repository-link";
import { repoLocalRegistryPath } from "../src/runtime/repo-local";
import { initRepo } from "./git-checkouts";

export interface LinkedClone {
  root: string;
  companionPath: string;
  /** The main worktree, the clone's Registered Checkout. */
  main: string;
  /** A global config listing only this companion. */
  store: GlobalConfigStore;
  /** The companion registry's text as written. */
  registry: string;
}

/**
 * A companion listing a real Git clone `acme` at its main worktree, which
 * carries its own link. `roots` collects the temporary folder for clean-up.
 */
export async function linkedClone(roots: string[]): Promise<LinkedClone> {
  const root = await createTempDir("mate-adoption-");
  roots.push(root);
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    stringify({ type: "companion", allowedAgents: ["claude", "opencode"] }),
  );
  const main = initRepo(path.join(root, "acme"));
  const registry = stringify({
    repos: [{ id: "acme", path: main, gitCommonDir: path.join(main, ".git") }],
  });
  await fs.writeFile(companionRegistryPath(companionPath), registry);
  const local = repoLocalRegistryPath(main);
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(
    local,
    stringify({
      repository: { id: "acme", path: main },
      companions: [{ path: companionPath, repositoryId: "acme" }],
    }),
  );
  const store = new GlobalConfigStore(path.join(root, "config.yaml"));
  await store.register(companionPath);
  return { root, companionPath, main, store, registry };
}
