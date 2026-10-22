import { describe, expect, test } from "claude-code/testing";
import {
  type Entry,
  type SecretPolicy,
  folderNote,
  isAbsolute,
  isInside,
  joinPath,
  parseMention,
  parsePolicy,
  queryOf,
  rank,
  relativeInside,
  rowText,
  secretMatch,
  toEntries,
} from "../hooks/companion.ts";
import { RULES, policyJson, type PolicyOptions } from "./policy.ts";

/** The policy mate would hand over with `options`, parsed. */
function policyOf(options: PolicyOptions = {}): SecretPolicy {
  const parsed = parsePolicy(policyJson(options));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.policy;
}

const defaults = policyOf();

const entries = toEntries(
  [
    "AGENTS.md",
    "README.md",
    "openspec/config.yaml",
    "openspec/mate-conventions.yaml",
    "openspec/changes/add-dark-mode/tasks.md",
    "openspec/changes/add-dark-mode/proposal.md",
    "openspec/changes/cache-search-results/tasks.md",
    "openspec/changes/archive/2025-01-01-old/tasks.md",
    "openspec/specs/index.md",
    ".mate/config/registry.yaml",
    ".graphify/app/graphify-out/notes/Task Runner.md",
    "notes/meeting notes.md",
    "notes/Café",
    "notes/a#b.md",
    "notes/back\\slash.md",
    'notes/"quoted" name.md',
    ".env",
    ".ENV.local",
    ".env.example",
    "certs/server.pem",
    "nested/",
  ],
  defaults,
);

const rels = (list: readonly Entry[]) => list.map((entry) => entry.rel);
const explicit = (query: string) => ({ query, isExplicit: true });
const implicit = (query: string) => ({ query, isExplicit: false });

describe("the file list", () => {
  test("adds each parent folder once", () => {
    expect(rels(entries).filter((rel) => rel === "openspec/")).toHaveLength(1);
    expect(entries).toContainEqual({ rel: "openspec/changes/add-dark-mode/", isDir: true });
    expect(toEntries(["a.md", "a.md"], defaults)).toEqual([{ rel: "a.md", isDir: false }]);
  });

  test("a nested repository git lists as `nested/` is one folder", () => {
    expect(entries.filter((entry) => entry.rel === "nested/")).toEqual([
      { rel: "nested/", isDir: true },
    ]);
  });

  test("leaves out secret files and paths no mention can name", () => {
    for (const rel of [
      ".env",
      ".ENV.local",
      "certs/server.pem",
      "certs/",
      "notes/a#b.md",
      "notes/back\\slash.md",
      'notes/"quoted" name.md',
    ]) {
      expect(rels(entries)).not.toContain(rel);
    }
    expect(rels(entries)).toContain(".env.example");
    expect(rels(entries)).toContain("notes/meeting notes.md");
    expect(rels(entries)).toContain("notes/Café");
  });

  test("follows the companion's own secret patterns", () => {
    const files = ["infra/acme.tfstate", "infra/main.tf", ".env"];
    expect(rels(toEntries(files, policyOf({ deny: ["*.tfstate"] })))).toEqual([
      "infra/",
      "infra/main.tf",
    ]);
    expect(rels(toEntries(files, policyOf({ guardrails: false })))).toContain(".env");
  });
});

describe("rows", () => {
  test("a file ends the token; a folder keeps it open for what it holds", () => {
    expect(rowText({ rel: "openspec/config.yaml", isDir: false })).toBe(
      "@mate:openspec/config.yaml ",
    );
    expect(rowText({ rel: "openspec/", isDir: true })).toBe("@mate:openspec/");
  });

  test("quotes paths the engine would cut: spaces, or a last character it trims", () => {
    expect(rowText({ rel: "notes/meeting notes.md", isDir: false })).toBe(
      '@"mate:notes/meeting notes.md" ',
    );
    expect(rowText({ rel: "notes/Café", isDir: false })).toBe('@"mate:notes/Café" ');
    expect(rowText({ rel: "drafts (old)/", isDir: true })).toBe('@"mate:drafts (old)/" ');
    expect(rowText({ rel: "drafts-/", isDir: true })).toBe('@"mate:drafts-/" ');
  });

  test("offers nothing for a path no mention can name", () => {
    expect(rowText({ rel: "a#b.md", isDir: false })).toBeUndefined();
    expect(rowText({ rel: "a\\b.md", isDir: false })).toBeUndefined();
    expect(rowText({ rel: 'say "hi".md', isDir: false })).toBeUndefined();
    expect(rowText({ rel: "c:notes.md", isDir: false })).toBeUndefined();
    expect(rowText({ rel: "notes/c:plan.md", isDir: false })).toBe("@mate:notes/c:plan.md ");
  });

  test("reads @ tokens with and without the mate: prefix", () => {
    expect(queryOf("@tasks")).toEqual({ query: "tasks", isExplicit: false });
    expect(queryOf("@mate:open")).toEqual({ query: "open", isExplicit: true });
    expect(queryOf("@MATE:open")).toEqual({ query: "open", isExplicit: true });
    expect(queryOf("#123")).toBeUndefined();
    expect(queryOf('@"quoted path')).toBeUndefined();
  });
});

describe("ranking", () => {
  test("a chosen folder lists what it holds, folders first", () => {
    expect(rels(rank(entries, explicit("openspec/"), 15))).toEqual([
      "openspec/changes/",
      "openspec/specs/",
      "openspec/config.yaml",
      "openspec/mate-conventions.yaml",
    ]);
    expect(rels(rank(entries, explicit("openspec/changes/"), 15))).toEqual([
      "openspec/changes/add-dark-mode/",
      "openspec/changes/archive/",
      "openspec/changes/cache-search-results/",
    ]);
  });

  test("the rest of the query narrows the folder, then searches its tree", () => {
    expect(rels(rank(entries, explicit("openspec/changes/cac"), 15))).toEqual([
      "openspec/changes/cache-search-results/",
    ]);
    const tasks = rels(rank(entries, explicit("openspec/tasks"), 15));
    expect(tasks).toHaveLength(3);
    expect(tasks.every((rel) => rel.endsWith("/tasks.md"))).toBe(true);
  });

  test("@mate: alone lists the top level, mate's own folders last", () => {
    expect(rels(rank(entries, explicit(""), 15))).toEqual([
      "nested/",
      "notes/",
      "openspec/",
      ".env.example",
      "AGENTS.md",
      "README.md",
      ".graphify/",
      ".mate/",
    ]);
  });

  test("search finds a name anywhere, and letters in order", () => {
    const tasks = rels(rank(entries, explicit("tasks"), 3));
    expect(tasks).toHaveLength(3);
    expect(tasks.every((rel) => rel.endsWith("/tasks.md"))).toBe(true);
    expect(rels(rank(entries, explicit("mconv"), 15))).toEqual(["openspec/mate-conventions.yaml"]);
  });

  test("mate's own folders are searched only for a query starting with a dot", () => {
    expect(rank(entries, explicit("registry"), 15)).toEqual([]);
    expect(rels(rank(entries, explicit(".graph"), 1))).toEqual([".graphify/"]);
    expect(rels(rank(entries, explicit(".mate/"), 15))).toEqual([".mate/config/"]);
  });

  test("a query matches whatever its letter case", () => {
    expect(rels(rank(entries, explicit("AGENTS"), 1))).toEqual(["AGENTS.md"]);
    expect(rels(rank(entries, explicit("OpenSpec/"), 1))).toEqual(["openspec/changes/"]);
  });

  test("on a tie, folders come first, then shorter paths", () => {
    const tied = toEntries(["docs.md", "docsets/a.txt", "abc/tasks.md", "zz/tasks.md"], defaults);
    expect(rels(rank(tied, explicit("doc"), 2))).toEqual(["docsets/", "docs.md"]);
    expect(rels(rank(tied, explicit("tasks.md"), 2))).toEqual(["zz/tasks.md", "abc/tasks.md"]);
  });

  test("a bare @ offers only names holding the query", () => {
    expect(rank(entries, implicit(""), 3)).toEqual([]);
    expect(rank(entries, implicit("src/app"), 3)).toEqual([]);
    expect(rank(entries, implicit("mcv"), 3)).toEqual([]);
    const tasks = rels(rank(entries, implicit("task"), 3));
    expect(tasks).toHaveLength(3);
    expect(tasks.every((rel) => rel.endsWith("/tasks.md"))).toBe(true);
  });
});

describe("mentions", () => {
  test("name a path inside the companion", () => {
    expect(parseMention("mate:openspec/config.yaml#L2-4")).toEqual({ rel: "openspec/config.yaml" });
    expect(parseMention("mate:openspec/")).toEqual({ rel: "openspec" });
    expect(parseMention("mate:./openspec//config.yaml")).toEqual({ rel: "openspec/config.yaml" });
    expect(parseMention("mate:/AGENTS.md")).toEqual({ rel: "AGENTS.md" });
    expect(parseMention("MATE:openspec\\config.yaml")).toEqual({ rel: "openspec/config.yaml" });
    expect(parseMention("mate:")).toEqual({ rel: "" });
  });

  test("cannot leave the companion", () => {
    for (const mention of [
      "mate:../secrets.txt",
      "mate:x/../y.md",
      "mate:openspec/../../y.md",
      "mate:C:/Windows/win.ini",
      "mate:\\\\server\\share\\x",
    ]) {
      expect(parseMention(mention)).toHaveProperty("refused");
    }
  });

  test("other mentions are not mate: ones", () => {
    expect(parseMention("openspec/config.yaml")).toBeUndefined();
  });
});

describe("the secret policy", () => {
  test("is read from mate's launch policy", () => {
    const parsed = parsePolicy(policyJson());
    expect("policy" in parsed && parsed.policy.guardrails).toBe(true);
  });

  const failures: [string | undefined, string][] = [
    [undefined, "is not set"],
    ["", "is not set"],
    ["{not json", "is not JSON"],
    ['{"allowedAgents":["claude"]}', "holds no secret policy"],
    ['{"secrets":{"deny":[],"allow":[]}}', "guardrails"],
    ['{"secrets":{"guardrails":true,"allow":[]}}', "no deny list"],
    ['{"secrets":{"guardrails":true,"deny":[{"pattern":".env"}],"allow":[]}}', "malformed"],
  ];
  for (const [json, cause] of failures) {
    test(`fails for ${JSON.stringify(json)}, saying it ${cause}`, () => {
      const parsed = parsePolicy(json);
      expect("error" in parsed && parsed.error).toContain(cause);
    });
  }

  test("fails for a rule that does not compile, naming its pattern", () => {
    const broken = { pattern: "[x", source: "^[x$", flags: "i", subject: "name" };
    const json = JSON.stringify({ secrets: { guardrails: true, deny: [broken], allow: [] } });
    const parsed = parsePolicy(json);
    expect("error" in parsed && parsed.error).toContain("`[x` does not compile");
  });

  test("fails for a rule whose flags keep state between matches", () => {
    const sticky = { ...RULES[".env"], flags: "gi" };
    const json = JSON.stringify({ secrets: { guardrails: true, deny: [sticky], allow: [] } });
    expect(parsePolicy(json)).toHaveProperty("error");
  });
});

describe("secret files", () => {
  test("match a deny rule by name, whatever the letter case", () => {
    expect(secretMatch(defaults, ".env")).toBe(".env");
    expect(secretMatch(defaults, ".Env")).toBe(".env");
    expect(secretMatch(defaults, "config/.ENV.production")).toBe(".env.*");
    expect(secretMatch(defaults, "certs/server.pem")).toBe("*.pem");
    expect(secretMatch(defaults, "keys/ID_RSA")).toBe("id_rsa");
    expect(secretMatch(defaults, "keys\\api.KEY")).toBe("*.key");
  });

  test("leave allowed examples and look-alikes alone", () => {
    for (const path of [
      ".env.example",
      ".ENV.EXAMPLE",
      "deploy/.env.template",
      "environment.md",
      "id_rsa.pub",
      "keys.md",
      "",
    ]) {
      expect(secretMatch(defaults, path)).toBeUndefined();
    }
  });

  test("a pattern with a slash matches the path, one without matches the name", () => {
    const policy = policyOf({ deny: ["secrets/**", "*.tfstate"] });
    expect(secretMatch(policy, "secrets/token.txt")).toBe("secrets/**");
    expect(secretMatch(policy, "notes/secrets.md")).toBeUndefined();
    expect(secretMatch(policy, "infra/eu/acme.TFSTATE")).toBe("*.tfstate");
  });

  test("an allow rule wins over a deny rule", () => {
    expect(secretMatch(policyOf({ deny: ["*.tfstate"] }), ".env.sample")).toBeUndefined();
  });

  test("count for nothing with guardrails off", () => {
    expect(secretMatch(policyOf({ guardrails: false }), ".env")).toBeUndefined();
  });
});

describe("paths", () => {
  test("joins and compares paths", () => {
    expect(joinPath("/c/", "a.md")).toBe("/c/a.md");
    expect(joinPath("/c", "")).toBe("/c");
    expect(isInside("C:\\Users\\Me\\Companion\\a.md", "c:/users/me/companion")).toBe(true);
    expect(isInside("/companions/app-companion-old/a.md", "/companions/app-companion")).toBe(false);
  });

  test("give a path inside the companion relative to it", () => {
    expect(relativeInside("/c/notes/a.md", "/c")).toBe("notes/a.md");
    expect(relativeInside("/c/", "/c")).toBe("");
    expect(relativeInside("C:\\Users\\Me\\Companion\\Notes\\A.md", "c:/users/me/companion")).toBe(
      "Notes/A.md",
    );
    expect(relativeInside("/c-old/a.md", "/c")).toBeUndefined();
  });

  test("take a drive's root as a companion", () => {
    expect(relativeInside("C:/AGENTS.md", "C:/")).toBe("AGENTS.md");
    expect(relativeInside("c:\\Notes\\a.md", "C:\\")).toBe("Notes/a.md");
    expect(isInside("D:\\x.md", "C:\\")).toBe(false);
  });

  test("an absolute path starts at a root or a drive", () => {
    for (const path of ["/c", "\\c", "C:\\c", "c:/c"]) expect(isAbsolute(path)).toBe(true);
    for (const path of ["c", "./c", "C:c"]) expect(isAbsolute(path)).toBe(false);
  });
});

describe("folder notes", () => {
  test("list what the folder holds, folders first", () => {
    const note = folderNote(
      "@mate:openspec",
      "/c/openspec",
      [
        { name: "config.yaml", isDir: false },
        { name: "specs", isDir: true },
        { name: "changes", isDir: true },
      ],
      10,
    );
    expect(note).toBe(
      "@mate:openspec is the folder /c/openspec in the mate companion repo. It holds:\n- changes/\n- specs/\n- config.yaml",
    );
  });

  test("say how many more past the limit, and when it is empty", () => {
    const three = [
      { name: "a", isDir: false },
      { name: "b", isDir: false },
      { name: "c", isDir: false },
    ];
    expect(folderNote("@mate:x", "/c/x", three, 2)).toEndWith("- a\n- b\n- ... and 1 more");
    expect(folderNote("@mate:x", "/c/x", [], 2)).toBe(
      "@mate:x is the folder /c/x in the mate companion repo. It is empty.",
    );
  });
});
