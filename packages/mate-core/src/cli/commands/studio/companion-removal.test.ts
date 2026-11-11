import { describe, expect, it } from "bun:test";

import {
  CompanionRemovalError,
  deletableWithin,
  deleteRegisteredCompanion,
} from "./companion-removal";

const COMPANION = "/home/dev/.mate/companions/acme-companion";
const CONFIG = `${COMPANION}/.mate/config/framework.yaml`;

function fakes(options: {
  registered?: string[];
  dirs?: string[];
  files?: Record<string, string>;
}) {
  const registry = [...(options.registered ?? [COMPANION])];
  const removed: string[] = [];
  return {
    registry,
    removed,
    deps: {
      home: "/home/dev",
      store: {
        list: async () => registry,
        unregister: async (target: string) => {
          const at = registry.indexOf(target);
          if (at >= 0) registry.splice(at, 1);
          return at >= 0;
        },
      },
      isDirectory: async (target: string) => (options.dirs ?? [COMPANION]).includes(target),
      readFile: async (target: string) => {
        const text = (options.files ?? { [CONFIG]: "type: companion\n" })[target];
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      remove: async (target: string) => {
        removed.push(target);
      },
    },
  };
}

describe("deleteRegisteredCompanion", () => {
  it("deletes a companion's folder and unregisters it", async () => {
    const { deps, registry, removed } = fakes({});
    expect(await deleteRegisteredCompanion(COMPANION, deps)).toEqual({
      companionPath: COMPANION,
      deletedFolder: true,
    });
    expect(removed).toEqual([COMPANION]);
    expect(registry).toEqual([]);
  });

  it("only unregisters a stale entry whose folder is gone", async () => {
    const { deps, registry, removed } = fakes({ dirs: [] });
    expect((await deleteRegisteredCompanion(COMPANION, deps)).deletedFolder).toBe(false);
    expect(removed).toEqual([]);
    expect(registry).toEqual([]);
  });

  it("refuses a path that is not registered", async () => {
    const { deps, removed } = fakes({ registered: [] });
    await expect(deleteRegisteredCompanion(COMPANION, deps)).rejects.toBeInstanceOf(
      CompanionRemovalError,
    );
    expect(removed).toEqual([]);
  });

  it("never deletes the home folder, a folder holding it, or a folder without companion configuration", async () => {
    for (const target of ["/home/dev", "/home", "/"]) {
      const { deps, removed, registry } = fakes({ registered: [target], dirs: [target] });
      await expect(deleteRegisteredCompanion(target, deps)).rejects.toBeInstanceOf(
        CompanionRemovalError,
      );
      expect(removed).toEqual([]);
      expect(registry).toEqual([target]);
    }
    const bare = fakes({ files: {} });
    await expect(deleteRegisteredCompanion(COMPANION, bare.deps)).rejects.toBeInstanceOf(
      CompanionRemovalError,
    );
    const working = fakes({ files: { [CONFIG]: "type: working\n" } });
    await expect(deleteRegisteredCompanion(COMPANION, working.deps)).rejects.toBeInstanceOf(
      CompanionRemovalError,
    );
    expect([...bare.removed, ...working.removed]).toEqual([]);
  });

  it("with deleteWithin, deletes a companion inside it and only unregisters one outside", async () => {
    const inside = fakes({ registered: [COMPANION], dirs: [COMPANION] });
    expect(
      (
        await deleteRegisteredCompanion(COMPANION, {
          ...inside.deps,
          deleteWithin: "/home/dev/.mate/companions",
        })
      ).deletedFolder,
    ).toBe(true);
    expect(inside.removed).toEqual([COMPANION]);

    const outside = fakes({ registered: [COMPANION], dirs: [COMPANION] });
    expect(
      await deleteRegisteredCompanion(COMPANION, { ...outside.deps, deleteWithin: "/companions" }),
    ).toEqual({ companionPath: COMPANION, deletedFolder: false });
    expect(outside.removed).toEqual([]);
    expect(outside.registry).toEqual([]);
  });

  it("with deleteWithin, never deletes the directory itself", async () => {
    const root = fakes({
      registered: ["/companions"],
      dirs: ["/companions"],
      files: { "/companions/.mate/config/framework.yaml": "type: companion\n" },
    });
    const result = await deleteRegisteredCompanion("/companions", {
      ...root.deps,
      deleteWithin: "/companions",
    });
    expect(result.deletedFolder).toBe(false);
    expect(root.removed).toEqual([]);
  });
});

describe("deletableWithin", () => {
  it("allows a folder strictly inside the directory however the directory is spelled", () => {
    for (const dir of ["/companions", "/companions/", "/companions/./", "/srv/../companions"]) {
      expect(deletableWithin("/companions/acme-companion", dir)).toBe(true);
      expect(deletableWithin("/companions", dir)).toBe(false);
      expect(deletableWithin("/companions-other/acme-companion", dir)).toBe(false);
      expect(deletableWithin("/companions/../srv/acme-companion", dir)).toBe(false);
    }
  });

  it("allows any folder without a directory", () => {
    expect(deletableWithin("/srv/acme-companion", undefined)).toBe(true);
  });
});
