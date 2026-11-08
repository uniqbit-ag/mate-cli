import { describe, expect, test } from "bun:test";

import type { WorkspaceInventoryV1 } from "../orchestrator/workspace-inventory";
import { repositoryForPath, resolveUsageScope, type UsageScopeDeps } from "./scope";

function fixtures(): { inventory: WorkspaceInventoryV1; deps: UsageScopeDeps } {
  const inventory: WorkspaceInventoryV1 = {
    schemaVersion: 1,
    companions: [{ path: "/acme/companion", health: "ready" }],
    pairings: ["web", "api", "web-copy", "missing"].map((name) => ({
      companionPath: "/acme/companion",
      repository: { id: `acme/${name}`, path: `/acme/${name}` },
      health: name === "missing" ? "missing-repository" : "ready",
      ambiguous: false,
    })),
  };
  return {
    inventory,
    deps: {
      inventory: async () => inventory,
      capabilities: async () => ["tokensave"],
      checkouts: async (entry) => [{ path: entry.path, origin: null, remote: null }],
      registered: (entry) => (entry.path === "/acme/missing" ? null : entry.path),
      identity: (folder) =>
        folder === "/acme/web-copy"
          ? { key: "/acme/web", aliases: ["/acme/web", "/acme/web-copy"] }
          : { key: folder, aliases: [folder] },
    },
  };
}

describe("usage scope", () => {
  test("includes every pairing and collapses worktree aliases without merging separate clones", async () => {
    const { deps } = fixtures();
    const scope = await resolveUsageScope("/acme/companion", deps);
    expect(scope.repositories.map((repo) => repo.label)).toEqual([
      "Companion Repository",
      "acme/api",
      "acme/missing",
      "acme/web",
    ]);
    expect(scope.repositories.find((repo) => repo.label === "acme/missing")?.available).toBe(false);
    expect(repositoryForPath(scope, "/acme/web-copy/src")?.label).toBe("acme/web");
    expect(repositoryForPath(scope, "/acme/web-other")).toBeNull();
    expect(repositoryForPath(scope, "web")).toBeNull();
  });

  test("keeps companion-only scope and changes fingerprint with links/capabilities", async () => {
    const { deps, inventory } = fixtures();
    const first = await resolveUsageScope("/acme/companion", deps);
    inventory.pairings = [];
    const next = await resolveUsageScope("/acme/companion", deps);
    expect(next.repositories).toHaveLength(1);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    deps.capabilities = async () => [];
    expect((await resolveUsageScope("/acme/companion", deps)).fingerprint).not.toBe(
      next.fingerprint,
    );
  });

  test("excludes unrelated pairings, but shared repositories count within each companion", async () => {
    const { deps, inventory } = fixtures();
    inventory.companions.push({ path: "/acme/other", health: "ready" });
    inventory.pairings.push({ ...inventory.pairings[0]!, companionPath: "/acme/other" });
    const other = await resolveUsageScope("/acme/other", deps);
    expect(other.repositories.map((repo) => repo.label)).toEqual([
      "Companion Repository",
      "acme/web",
    ]);
    expect((await resolveUsageScope("/acme/companion", deps)).repositories).toHaveLength(4);
    await expect(resolveUsageScope("/acme/unregistered", deps)).rejects.toThrow(
      "not readable or registered",
    );
    inventory.companions[0]!.health = "unreadable";
    await expect(resolveUsageScope("/acme/companion", deps)).rejects.toThrow(
      "not readable or registered",
    );
  });

  test("expands trusted umbrella members and retains distinct colliding names", async () => {
    const { deps, inventory } = fixtures();
    inventory.pairings = [inventory.pairings[0]!];
    deps.checkouts = async () =>
      ["one", "two"].map((name) => ({
        path: `/acme/${name}/web`,
        origin: null,
        remote: { host: "github.com", owner: `acme/${name}`, repo: "web" },
      }));
    const scope = await resolveUsageScope("/acme/companion", deps);
    expect(scope.repositories.map((repo) => repo.label)).toEqual([
      "Companion Repository",
      "acme/one/web",
      "acme/two/web",
    ]);
  });

  test("follows a moved checkout of a missing registry entry", async () => {
    const { deps, inventory } = fixtures();
    inventory.pairings = [inventory.pairings[3]!];
    deps.registered = () => "/acme/moved";
    const scope = await resolveUsageScope("/acme/companion", deps);
    const moved = scope.repositories.find((repo) => repo.kind === "working");
    expect(moved).toMatchObject({ path: "/acme/moved", available: true });
  });
});
