import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FactoryError } from "../../../lib/factory/ids";
import { readLocalRepositories } from "../../../lib/workset/factory-local";
import { addRepository, removeRepository } from "./repository-add";

const WEB = "https://git.acme.test/acme/web.git";
let companion: string;

beforeEach(() => {
  companion = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-repository-add-")));
});
afterEach(() => fs.rmSync(companion, { recursive: true, force: true }));

function fakes(check: (url: string) => Promise<void> = async () => {}) {
  const checked: string[] = [];
  return {
    checked,
    deps: {
      env: {},
      client: {
        checkRemote: async (url: string) => {
          checked.push(url);
          await check(url);
        },
      },
      isDirectory: async (target: string) => target.startsWith("/home/dev"),
      originOf: async (checkout: string) =>
        checkout === "/home/dev/acme-web" ? "git@git.acme.test:acme/web.git" : null,
    },
  };
}

const listed = async () => (await readLocalRepositories(companion)).urls;

describe("adding a repository by Git URL", () => {
  it("checks that it answers, then lists it", async () => {
    const { deps, checked } = fakes();
    expect(await addRepository(companion, { kind: "url", url: ` ${WEB} ` }, deps)).toEqual({
      ok: true,
      identity: "acme/web",
      existing: false,
    });
    expect(checked).toEqual([WEB]);
    expect(await listed()).toEqual([WEB]);
  });

  it("an unreachable remote adds nothing", async () => {
    const { deps } = fakes(async () => {
      throw new FactoryError("reaching acme/web failed: repository not found");
    });
    expect(await addRepository(companion, { kind: "url", url: WEB }, deps)).toEqual({
      ok: false,
      reason: "reaching acme/web failed: repository not found",
    });
    expect(await listed()).toEqual([]);
    expect(fs.existsSync(path.join(companion, "factory.local.yaml"))).toBe(false);
  });

  it("an authentication refusal names the Git token that would unlock it", async () => {
    const { deps } = fakes(async () => {
      throw new FactoryError("authentication to git.acme.test/acme failed", "auth");
    });
    expect(await addRepository(companion, { kind: "url", url: WEB }, deps)).toEqual({
      ok: false,
      reason: expect.stringContaining("authentication"),
      tokenKey: "git.acme.test/acme",
    });
    expect(await listed()).toEqual([]);
  });

  it("a repository already offered is reported and nothing runs or changes", async () => {
    const { deps, checked } = fakes();
    await addRepository(companion, { kind: "url", url: WEB }, deps);
    const before = fs.readFileSync(path.join(companion, "factory.local.yaml"), "utf8");
    checked.length = 0;
    expect(
      await addRepository(companion, { kind: "url", url: "git@git.acme.test:acme/web.git" }, deps),
    ).toEqual({ ok: true, identity: "acme/web", existing: true });
    expect(checked).toEqual([]);
    expect(fs.readFileSync(path.join(companion, "factory.local.yaml"), "utf8")).toBe(before);

    const fromEnvironment = await addRepository(
      companion,
      { kind: "url", url: "https://git.acme.test/acme/api.git" },
      { ...deps, env: { MATE_FACTORY_REPOSITORIES: "https://git.acme.test/acme/api.git" } },
    );
    expect(fromEnvironment).toMatchObject({ ok: true, existing: true });
    expect(await listed()).toEqual([WEB]);
  });

  it("refuses a local path, a file URL and a URL with no organization before checking", async () => {
    const { deps, checked } = fakes();
    for (const url of ["/srv/web", "file:///srv/web", "https://git.acme.test/web", ""]) {
      const result = await addRepository(companion, { kind: "url", url }, deps);
      expect(result.ok).toBe(false);
    }
    expect(checked).toEqual([]);
  });

  it("an unusable file refuses the add and is left as it is", async () => {
    const file = path.join(companion, "factory.local.yaml");
    fs.writeFileSync(file, "repositories:\n  - https://git.acme.test/web\n");
    const { deps } = fakes();
    const result = await addRepository(companion, { kind: "url", url: WEB }, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("factory.local.yaml"),
    });
    expect(fs.readFileSync(file, "utf8")).toBe("repositories:\n  - https://git.acme.test/web\n");
  });
});

describe("adding a repository from a local checkout", () => {
  it("lists the checkout's origin, not its path", async () => {
    const { deps, checked } = fakes();
    expect(
      await addRepository(companion, { kind: "path", path: "/home/dev/acme-web" }, deps),
    ).toEqual({
      ok: true,
      identity: "acme/web",
      existing: false,
    });
    expect(checked).toEqual(["git@git.acme.test:acme/web.git"]);
    expect(await listed()).toEqual(["git@git.acme.test:acme/web.git"]);
  });

  it("refuses a relative path, a missing folder and a checkout with no origin", async () => {
    const { deps, checked } = fakes();
    for (const given of ["acme-web", "/srv/acme-web", "/home/dev/other"]) {
      expect((await addRepository(companion, { kind: "path", path: given }, deps)).ok).toBe(false);
    }
    expect(checked).toEqual([]);
    expect(await listed()).toEqual([]);
  });

  it("refuses an origin that names no org/repository", async () => {
    const { deps } = fakes();
    const result = await addRepository(
      companion,
      { kind: "path", path: "/home/dev/acme-web" },
      {
        ...deps,
        originOf: async () => "https://git.acme.test/web",
      },
    );
    expect(result.ok).toBe(false);
    expect(await listed()).toEqual([]);
  });
});

describe("removing a listed repository", () => {
  it("removes the entry, and says so when it is not one of the list's own", async () => {
    const { deps } = fakes();
    await addRepository(companion, { kind: "url", url: WEB }, deps);
    expect(await removeRepository(companion, "acme/web")).toEqual({ ok: true });
    expect(await listed()).toEqual([]);
    expect(await removeRepository(companion, "acme/web")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not in the list"),
    });
  });
});
