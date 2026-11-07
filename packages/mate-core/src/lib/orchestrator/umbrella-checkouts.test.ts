import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  linkedCheckoutsOf,
  mirroredUmbrellaOf,
  umbrellaChildrenOf,
  umbrellaFolderOf,
} from "./umbrella-checkouts";

let root: string;
let umbrella: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-umbrella-")));
  umbrella = path.join(root, "acme");
  fs.mkdirSync(umbrella);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

function ownLink(dir: string): void {
  fs.mkdirSync(path.join(dir, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mate", "config", "registry.yaml"), "companions: []\n");
}

describe("linkedCheckoutsOf", () => {
  test("an umbrella yields its children in name order, tagged with the umbrella", async () => {
    repo(path.join(umbrella, "web"), "https://github.com/acme/web.git");
    repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    expect(await linkedCheckoutsOf({ path: umbrella })).toEqual([
      {
        path: path.join(umbrella, "api"),
        origin: "git@github.com:acme/api.git",
        remote: expect.objectContaining({ owner: "acme", repo: "api" }),
        umbrella,
      },
      {
        path: path.join(umbrella, "web"),
        origin: "https://github.com/acme/web.git",
        remote: expect.objectContaining({ owner: "acme", repo: "web" }),
        umbrella,
      },
    ]);
  });

  test("many children are read a few at a time, still in name order", async () => {
    const names = Array.from({ length: 20 }, (_, at) => `acme-${String(at).padStart(2, "0")}`);
    for (const name of names) fs.mkdirSync(path.join(umbrella, name, ".git"), { recursive: true });
    let running = 0;
    let peak = 0;
    const readOrigin = async (checkout: string) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return `git@github.com:acme/${path.basename(checkout)}.git`;
    };
    const children = await umbrellaChildrenOf(umbrella, readOrigin);
    expect(children.map((entry) => path.basename(entry.path))).toEqual(names);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("an entry's own origin and its children's are read by their own readers", async () => {
    fs.mkdirSync(path.join(umbrella, "api", ".git"), { recursive: true });
    const entryReads: string[] = [];
    const checkouts = await linkedCheckoutsOf(
      { path: umbrella },
      async (checkout) => {
        entryReads.push(checkout);
        return null;
      },
      async () => "git@github.com:acme/api.git",
    );
    expect(checkouts.map((entry) => entry.origin)).toEqual(["git@github.com:acme/api.git"]);
    expect(entryReads).toEqual([]);
  });

  test("a nested repository is not scanned", async () => {
    repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    repo(path.join(umbrella, "backend", "billing"), "git@github.com:acme/billing.git");
    const paths = (await linkedCheckoutsOf({ path: umbrella })).map((entry) => entry.path);
    expect(paths).toEqual([path.join(umbrella, "api")]);
  });

  test("a child without a forge origin is skipped", async () => {
    repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    repo(path.join(umbrella, "scratch"));
    const paths = (await linkedCheckoutsOf({ path: umbrella })).map((entry) => entry.path);
    expect(paths).toEqual([path.join(umbrella, "api")]);
  });

  test("a child with its own Repository Link is skipped", async () => {
    ownLink(repo(path.join(umbrella, "api"), "git@github.com:acme/api.git"));
    repo(path.join(umbrella, "web"), "git@github.com:acme/web.git");
    const paths = (await linkedCheckoutsOf({ path: umbrella })).map((entry) => entry.path);
    expect(paths).toEqual([path.join(umbrella, "web")]);
  });

  test("a linked Git checkout stays a single checkout, even with Git children", async () => {
    repo(umbrella, "git@github.com:acme/acme.git");
    repo(path.join(umbrella, "vendor"), "git@github.com:acme/vendor.git");
    expect(await linkedCheckoutsOf({ path: umbrella })).toEqual([
      {
        path: umbrella,
        origin: "git@github.com:acme/acme.git",
        remote: expect.objectContaining({ owner: "acme", repo: "acme" }),
      },
    ]);
    expect(await umbrellaChildrenOf(umbrella)).toEqual([]);
  });

  test("a plain folder without Git children yields itself without origin", async () => {
    fs.mkdirSync(path.join(umbrella, "notes"));
    expect(await linkedCheckoutsOf({ path: umbrella })).toEqual([
      { path: umbrella, origin: null, remote: null },
    ]);
  });

  test("a child cloned later appears on the next lookup", async () => {
    repo(path.join(umbrella, "api"), "git@github.com:acme/api.git");
    expect(await linkedCheckoutsOf({ path: umbrella })).toHaveLength(1);
    repo(path.join(umbrella, "docs"), "git@github.com:acme/docs.git");
    const paths = (await linkedCheckoutsOf({ path: umbrella })).map((entry) => entry.path);
    expect(paths).toEqual([path.join(umbrella, "api"), path.join(umbrella, "docs")]);
  });
});

describe("umbrellaFolderOf", () => {
  test("the linked umbrella, from itself and from a plain folder inside it", () => {
    ownLink(umbrella);
    repo(path.join(umbrella, "api"));
    fs.mkdirSync(path.join(umbrella, "notes"));
    expect(umbrellaFolderOf(umbrella)).toBe(umbrella);
    expect(umbrellaFolderOf(path.join(umbrella, "notes"))).toBe(umbrella);
  });

  test("a mirrored worktree, whose children are linked worktrees", () => {
    ownLink(umbrella);
    const api = repo(path.join(umbrella, "api"));
    execFileSync("git", ["-C", api, "commit", "-q", "--allow-empty", "-m", "init"]);
    const mirrored = path.join(root, "acme.worktrees", "acme-fix");
    fs.mkdirSync(mirrored, { recursive: true });
    ownLink(mirrored);
    execFileSync("git", ["-C", api, "worktree", "add", "-q", path.join(mirrored, "api")]);
    expect(umbrellaFolderOf(mirrored)).toBe(mirrored);
    expect(mirroredUmbrellaOf(mirrored)).toBe(umbrella);
    expect(mirroredUmbrellaOf(umbrella)).toBeNull();
  });

  test("null in a child checkout", () => {
    ownLink(umbrella);
    const api = repo(path.join(umbrella, "api"));
    fs.mkdirSync(path.join(api, "src"));
    expect(umbrellaFolderOf(api)).toBeNull();
    expect(umbrellaFolderOf(path.join(api, "src"))).toBeNull();
  });

  test("null in a plain folder, linked or not, without child checkouts", () => {
    expect(umbrellaFolderOf(umbrella)).toBeNull();
    ownLink(umbrella);
    fs.mkdirSync(path.join(umbrella, "notes"));
    expect(umbrellaFolderOf(umbrella)).toBeNull();
  });

  test("a child with its own link is no umbrella child", () => {
    ownLink(umbrella);
    const api = repo(path.join(umbrella, "api"));
    ownLink(api);
    expect(umbrellaFolderOf(umbrella)).toBeNull();
  });
});
