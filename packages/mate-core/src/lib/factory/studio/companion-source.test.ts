import { describe, expect, it } from "bun:test";

import { FactoryError } from "../ids";
import { factoryCompanionSource } from "./companion-source";

const DIR = "/companions";
const URL = "https://git.acme.test/acme/acme-companion.git";
const CLONE = `${DIR}/acme-companion`;

function source(
  outcome: { path: string; existing: boolean } | FactoryError = { path: CLONE, existing: false },
) {
  const cloned: string[] = [];
  const companions = factoryCompanionSource(
    {
      cloneCompanion: async (url: string) => {
        cloned.push(url);
        if (outcome instanceof FactoryError) throw outcome;
        return outcome;
      },
    },
    DIR,
  );
  return { companions, cloned };
}

describe("the factory's companion source", () => {
  it("clones through the broker and reports the checkout", async () => {
    const { companions, cloned } = source();
    expect(companions.folder).toBe(DIR);
    expect(await companions.addByUrl(` ${URL} `)).toEqual({
      ok: true,
      path: CLONE,
      existing: false,
    });
    expect(cloned).toEqual([URL]);
  });

  it("refuses a local path or a file URL before asking the broker", async () => {
    const { companions, cloned } = source();
    for (const url of ["/srv/companion", "file:///srv/companion", ""]) {
      expect((await companions.addByUrl(url)).ok).toBe(false);
    }
    expect(cloned).toEqual([]);
  });

  it("offers the Git token key when the clone was refused for authentication", async () => {
    const { companions } = source(
      new FactoryError(
        "cloning acme/acme-companion failed: authentication to git.acme.test/acme failed",
        "auth",
      ),
    );
    expect(await companions.addByUrl(URL)).toEqual({
      ok: false,
      reason: expect.stringContaining("git.acme.test/acme"),
      tokenKey: "git.acme.test/acme",
    });
  });

  it("reports any other refusal without a token key", async () => {
    const { companions } = source(
      new FactoryError("/companions/acme-companion already holds a different repository"),
    );
    expect(await companions.addByUrl(URL)).toEqual({
      ok: false,
      reason: expect.stringContaining("different repository"),
    });
  });
});
