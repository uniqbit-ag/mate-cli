import { describe, expect, it } from "bun:test";

import { FactoryError } from "../../../lib/factory/ids";
import type { CompanionRegistrationResult } from "../../../lib/orchestrator/companion-registration";
import { addCompanionByPath, addCompanionByUrl } from "./companion-add";

const DIR = "/companions";
const URL = "https://git.acme.test/acme/acme-companion.git";
const CLONE = `${DIR}/acme-companion`;

function fakes(
  options: {
    clone?: { path: string; existing: boolean } | FactoryError;
    registered?: Record<string, CompanionRegistrationResult>;
    dirs?: string[];
  } = {},
) {
  const removed: string[] = [];
  const registered: string[] = [];
  const cloned: string[] = [];
  return {
    removed,
    registered,
    cloned,
    deps: {
      companionsDir: DIR,
      client: {
        cloneCompanion: async (url: string) => {
          cloned.push(url);
          const outcome = options.clone ?? { path: CLONE, existing: false };
          if (outcome instanceof FactoryError) throw outcome;
          return outcome;
        },
      },
      register: async (target: string): Promise<CompanionRegistrationResult> => {
        registered.push(target);
        return (
          options.registered?.[target] ?? {
            ok: true,
            companionPath: target,
            alreadyRegistered: false,
          }
        );
      },
      isDirectory: async (target: string) => (options.dirs ?? [target]).includes(target),
      remove: async (target: string) => {
        removed.push(target);
      },
    },
  };
}

describe("adding a companion by Git URL", () => {
  it("clones through the broker, registers the checkout and reports it", async () => {
    const { deps, cloned, registered } = fakes();
    expect(await addCompanionByUrl(` ${URL} `, deps)).toEqual({
      ok: true,
      companionPath: CLONE,
      existing: false,
    });
    expect(cloned).toEqual([URL]);
    expect(registered).toEqual([CLONE]);
  });

  it("refuses a local path or a file URL before asking the broker", async () => {
    const { deps, cloned } = fakes();
    for (const url of ["/srv/companion", "file:///srv/companion", ""]) {
      const result = await addCompanionByUrl(url, deps);
      expect(result.ok).toBe(false);
    }
    expect(cloned).toEqual([]);
  });

  it("offers the Git token key when the clone was refused for authentication", async () => {
    const { deps, registered } = fakes({
      clone: new FactoryError(
        "cloning acme/acme-companion failed: authentication to git.acme.test/acme failed",
        "auth",
      ),
    });
    expect(await addCompanionByUrl(URL, deps)).toEqual({
      ok: false,
      reason: expect.stringContaining("git.acme.test/acme"),
      tokenKey: "git.acme.test/acme",
    });
    expect(registered).toEqual([]);
  });

  it("any other refusal is reported without a token key", async () => {
    const { deps } = fakes({
      clone: new FactoryError("/companions/acme-companion already holds a different repository"),
    });
    const result = await addCompanionByUrl(URL, deps);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("different repository") });
  });

  it("removes a fresh clone that is not a companion and registers nothing", async () => {
    const { deps, removed } = fakes({
      registered: {
        [CLONE]: { ok: false, companionPath: CLONE, reason: "there is nothing to register." },
      },
    });
    const result = await addCompanionByUrl(URL, deps);
    expect(result).toEqual({
      ok: false,
      reason: "That repository is not a companion: there is nothing to register.",
    });
    expect(removed).toEqual([CLONE]);
  });

  it("never removes a checkout that was already there", async () => {
    const { deps, removed } = fakes({
      clone: { path: CLONE, existing: true },
      registered: { [CLONE]: { ok: false, companionPath: CLONE, reason: "nothing to register." } },
    });
    expect((await addCompanionByUrl(URL, deps)).ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it("an existing checkout is registered and reported as already added", async () => {
    const { deps, cloned } = fakes({ clone: { path: CLONE, existing: true } });
    expect(await addCompanionByUrl(URL, deps)).toEqual({
      ok: true,
      companionPath: CLONE,
      existing: true,
    });
    expect(cloned).toHaveLength(1);
  });
});

describe("adding a companion by local path", () => {
  const HOME = "/home/dev/acme-companion";

  it("registers the folder in place and nothing else", async () => {
    const { deps, registered, removed } = fakes();
    expect(await addCompanionByPath(HOME, deps)).toEqual({
      ok: true,
      companionPath: HOME,
      existing: false,
    });
    expect(registered).toEqual([HOME]);
    expect(removed).toEqual([]);
  });

  it("reports a registered companion as already added", async () => {
    const { deps } = fakes({
      registered: { [HOME]: { ok: true, companionPath: HOME, alreadyRegistered: true } },
    });
    expect(await addCompanionByPath(HOME, deps)).toMatchObject({ ok: true, existing: true });
  });

  it("refuses a relative path, a missing folder and a folder that is not a companion", async () => {
    const relative = fakes();
    expect((await addCompanionByPath("acme-companion", relative.deps)).ok).toBe(false);
    expect(relative.registered).toEqual([]);

    const missing = fakes({ dirs: [] });
    expect(await addCompanionByPath(HOME, missing.deps)).toEqual({
      ok: false,
      reason: `${HOME} is not a folder Studio can read.`,
    });
    expect(missing.registered).toEqual([]);

    const bare = fakes({
      registered: {
        [HOME]: { ok: false, companionPath: HOME, reason: "there is nothing to register." },
      },
    });
    expect(await addCompanionByPath(HOME, bare.deps)).toEqual({
      ok: false,
      reason: "there is nothing to register.",
    });
    expect(bare.removed).toEqual([]);
  });
});
