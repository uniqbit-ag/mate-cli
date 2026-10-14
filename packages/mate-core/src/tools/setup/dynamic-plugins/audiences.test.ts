import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  allPluginDeclarations,
  declaredAudiences,
  effectivePluginDeclarations,
  effectiveStudioAgent,
  readAllDeclarations,
  readAudienceSelection,
  readEffectiveDeclarations,
  readFrameworkRaw,
  resolveAudience,
} from "./audiences";

const base = { package: "@acme/base", version: "1.0.0" };
const analyst = { package: "@acme/analyst", version: "1.0.0" };
const reviewer = { package: "@acme/reviewer", version: "2.0.0" };

const raw = {
  plugins: [base],
  studio: { terminal: { agent: "developer" } },
  audiences: {
    ba: {
      plugins: [{ ...analyst, config: { mode: "ba" } }],
      studio: { terminal: { agent: "business-analyst" } },
    },
    qa: { plugins: [{ ...analyst, policy: "default", config: { mode: "qa" } }, reviewer] },
  },
};

describe("readAudienceSelection", () => {
  test.each([
    { name: "unset", env: {}, expected: null },
    { name: "empty", env: { MATE_AUDIENCE: "" }, expected: null },
    { name: "whitespace", env: { MATE_AUDIENCE: "  " }, expected: null },
    { name: "a name", env: { MATE_AUDIENCE: "ba" }, expected: "ba" },
    { name: "a padded name", env: { MATE_AUDIENCE: " ba " }, expected: "ba" },
  ])("$name", ({ env, expected }) => {
    expect(readAudienceSelection(env)).toBe(expected);
  });
});

describe("declaredAudiences", () => {
  test("lists audience names in declared order", () => {
    expect(declaredAudiences(raw)).toEqual(["ba", "qa"]);
  });

  test.each([{ name: "undefined" }, { name: "no key" }, { name: "non-mapping" }])(
    "is empty for $name",
    ({ name }) => {
      const input = name === "undefined" ? undefined : name === "no key" ? {} : { audiences: [] };
      expect(declaredAudiences(input)).toEqual([]);
    },
  );
});

describe("resolveAudience", () => {
  test("no selection is ok with no active audience", () => {
    expect(resolveAudience(raw, null)).toEqual({ ok: true, active: null });
  });

  test("a declared audience is active", () => {
    expect(resolveAudience(raw, "ba")).toEqual({ ok: true, active: "ba" });
  });

  test("an undeclared audience reports requested and declared", () => {
    expect(resolveAudience(raw, "dev")).toEqual({
      ok: false,
      requested: "dev",
      declared: ["ba", "qa"],
    });
  });

  test("an audience cannot be selected when none are declared", () => {
    expect(resolveAudience({ plugins: [base] }, "ba")).toEqual({
      ok: false,
      requested: "ba",
      declared: [],
    });
  });

  test("inherited object keys are not audiences", () => {
    expect(resolveAudience(raw, "constructor").ok).toBe(false);
  });
});

describe("effectivePluginDeclarations", () => {
  test("without an audience equals the base list", () => {
    expect(effectivePluginDeclarations(raw, null)).toEqual([base]);
  });

  test("appends the active audience after base in declared order", () => {
    expect(effectivePluginDeclarations(raw, "qa")).toEqual([
      base,
      { ...analyst, policy: "default", config: { mode: "qa" } },
      reviewer,
    ]);
  });

  test("retains the active audience's own policy and config", () => {
    const [, ba] = effectivePluginDeclarations(raw, "ba");
    expect(ba).toEqual({ ...analyst, config: { mode: "ba" } });
  });

  test("an unknown audience applies base only", () => {
    expect(effectivePluginDeclarations(raw, "dev")).toEqual([base]);
  });

  test("tolerates a missing or malformed config", () => {
    expect(effectivePluginDeclarations(undefined, "ba")).toEqual([]);
    expect(effectivePluginDeclarations({ plugins: "nope", audiences: { ba: 3 } }, "ba")).toEqual(
      [],
    );
  });
});

describe("allPluginDeclarations", () => {
  test("is base followed by every audience", () => {
    expect(
      allPluginDeclarations(raw).map((entry) => (entry as { package: string }).package),
    ).toEqual(["@acme/base", "@acme/analyst", "@acme/reviewer"]);
  });

  test("deduplicates a package shared by audiences only for installation", () => {
    const all = allPluginDeclarations(raw);
    expect(
      all.filter((entry) => (entry as { package: string }).package === analyst.package),
    ).toHaveLength(1);
    expect(effectivePluginDeclarations(raw, "ba")[1]).toMatchObject({ config: { mode: "ba" } });
    expect(effectivePluginDeclarations(raw, "qa")[1]).toMatchObject({ config: { mode: "qa" } });
  });

  test("equals the base list when no audiences are declared", () => {
    expect(allPluginDeclarations({ plugins: [base] })).toEqual([base]);
  });

  test("keeps malformed entries so callers can report them", () => {
    expect(allPluginDeclarations({ plugins: ["junk"] })).toEqual(["junk"]);
  });
});

describe("effectiveStudioAgent", () => {
  test("without an audience uses base", () => {
    expect(effectiveStudioAgent(raw, null)).toBe("developer");
  });

  test("the active audience overrides base", () => {
    expect(effectiveStudioAgent(raw, "ba")).toBe("business-analyst");
  });

  test("an audience without an agent inherits base", () => {
    expect(effectiveStudioAgent(raw, "qa")).toBe("developer");
  });

  test("an unknown audience uses base", () => {
    expect(effectiveStudioAgent(raw, "dev")).toBe("developer");
  });

  test("is undefined when neither names one", () => {
    expect(effectiveStudioAgent({ audiences: { ba: {} } }, "ba")).toBeUndefined();
    expect(effectiveStudioAgent(undefined, null)).toBeUndefined();
  });

  test("returns a non-string value as found for the caller to reject", () => {
    expect(effectiveStudioAgent({ studio: { terminal: { agent: 7 } } }, null)).toBe(7);
  });
});

describe("raw readers", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function companionWith(yaml: string | null): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "audiences-raw-"));
    tempRoots.push(root);
    if (yaml !== null) {
      const dir = path.join(root, ".mate", "config");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "framework.yaml"), yaml, "utf8");
    }
    return root;
  }

  const yaml = [
    "plugins:",
    '  - package: "@acme/base"',
    '    version: "1.0.0"',
    "audiences:",
    "  ba:",
    "    plugins:",
    '      - package: "@acme/analyst"',
    '        version: "1.0.0"',
    "",
  ].join("\n");

  test("readFrameworkRaw parses the file without creating anything", async () => {
    const root = await companionWith(yaml);
    expect(declaredAudiences(await readFrameworkRaw(root))).toEqual(["ba"]);
  });

  test("readFrameworkRaw returns null for a missing or unparsable file", async () => {
    expect(await readFrameworkRaw(await companionWith(null))).toBeNull();
    expect(await readFrameworkRaw(await companionWith(": : :\n  - ["))).toBeNull();
  });

  test("readEffectiveDeclarations reads base plus the active audience", async () => {
    const root = await companionWith(yaml);
    expect(await readEffectiveDeclarations(root, null)).toHaveLength(1);
    expect(await readEffectiveDeclarations(root, "ba")).toHaveLength(2);
  });

  test("readAllDeclarations reads base plus every audience", async () => {
    const root = await companionWith(yaml);
    expect(await readAllDeclarations(root)).toHaveLength(2);
  });

  test("readers return an empty list when the file is missing", async () => {
    const root = await companionWith(null);
    expect(await readEffectiveDeclarations(root, "ba")).toEqual([]);
    expect(await readAllDeclarations(root)).toEqual([]);
  });

  test("readers never write the config file", async () => {
    const root = await companionWith(yaml);
    await readAllDeclarations(root);
    await readEffectiveDeclarations(root, "ba");
    expect(await fs.readFile(path.join(root, ".mate", "config", "framework.yaml"), "utf8")).toBe(
      yaml,
    );
  });
});
