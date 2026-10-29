import { describe, expect, test } from "claude-code/testing";
import type { Engine, Plugin } from "claude-code/testing";
import type { PromptAutocompleteInput, PromptAutocompleteResult } from "claude-code";
import { contextReply, policyJson } from "./policy.ts";
import { world } from "./world.ts";

/** Each test has a companion of its own, so none sees a file list the mod kept for another. */

/** The kit raises prompt.autocomplete like any engine event, but its typings leave it off `$.prompt`. */
type Autocompleting = {
  autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult>;
};

function ask($: Engine, token: string) {
  return ($.prompt as unknown as Autocompleting).autocomplete({
    text: token,
    cursor: token.length,
    token,
    start: 0,
  });
}

async function texts($: Engine, token: string): Promise<string[]> {
  return (await ask($, token)).suggestions.map((row) => row.text);
}

const gitList = (...files: string[]) => ({ files });

const env = (root: string) => ({ MATE_ARTIFACT_PATH: root, MATE_POLICY_JSON: policyJson() });

/** A plugin above the mod that answers its first `@` lookup itself, 5 ms in, abandoning the mod's. */
const answersFirst: Plugin = {
  name: "answers-first",
  tier: "prepend",
  register(on) {
    let calls = 0;
    on("prompt.autocomplete", async ($, e, next) => {
      calls++;
      if (calls > 1) return next(e);
      void next(e).catch(() => undefined);
      await $.clock.sleep(5);
      return { suggestions: [] };
    });
  },
};

describe("@ rows", () => {
  test("fallback walking bounds the number of folders it visits", async ($, on) => {
    const root = "/c/walk-dirs";
    const folder = (name: string) => ({
      name,
      kind: "dir" as const,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    });
    const children = [
      ...Array.from({ length: 20_000 }, (_, i) => folder(`dir-${i}`)),
      folder("overflow"),
    ];
    world(on, {
      env: env(root),
      disk: { [root]: null, [`${root}/overflow/overflow-target.md`]: "" },
      listingOverrides: { [root]: children },
    });
    expect(await texts($, "@overflow-target")).toEqual([]);
  });

  test("fallback walking stops after its file budget even in one large folder", async ($, on) => {
    const disk = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [`/c/walk-limit/file-${i}.md`, ""]),
    );
    disk["/c/walk-limit/overflow-target.md"] = "";
    world(on, { env: env("/c/walk-limit"), disk });
    expect(await texts($, "@overflow-target")).toEqual([]);
  });

  test("other plugin results stay intact while plain searches browse and quote companion paths", async ($, on) => {
    const native = Array.from({ length: 25 }, (_, i) => ({
      text: `@file-${i}.md `,
      label: `file-${i}.md`,
    }));
    world(on, {
      upstreamSuggestions: native,
      env: env("/c/native-many"),
      disk: { "/c/native-many": null },
      git: { "/c/native-many": gitList("notes/acme/meeting notes.md") },
    });
    const expected = {
      text: '@"mate:notes/acme/meeting notes.md" ',
      label: "mate:notes/acme/meeting notes.md",
      description: "native-many (mate companion)",
    };
    expect((await ask($, "@notes/acme/")).suggestions).toEqual([...native, expected]);
    expect((await ask($, "@meeting")).suggestions).toEqual([...native, expected]);
  });

  test("other plugin and companion rows with the same name remain distinct", async ($, on) => {
    const native = { text: "@tasks.md ", label: "tasks.md", description: "Other plugin" };
    world(on, {
      upstreamSuggestions: [native],
      env: env("/c/collision"),
      disk: { "/c/collision": null },
      git: { "/c/collision": gitList("notes/tasks.md") },
    });
    expect((await ask($, "@tasks")).suggestions).toEqual([
      native,
      {
        text: "@mate:notes/tasks.md ",
        label: "mate:notes/tasks.md",
        description: "collision (mate companion)",
      },
    ]);
  });

  test("a failed companion lookup preserves other plugin suggestions", async ($, on) => {
    const native = [{ text: "@tasks.md ", label: "tasks.md", description: "Other plugin" }];
    world(on, { upstreamSuggestions: native, sessionError: "session lookup failed" });
    expect((await ask($, "@tasks")).suggestions).toEqual(native);
  });

  test("a chosen folder lists what it holds", async ($, on) => {
    world(on, {
      env: env("/c/drill"),
      disk: { "/c/drill": null },
      git: {
        "/c/drill": gitList(
          "openspec/config.yaml",
          "openspec/changes/fix-login/tasks.md",
          "AGENTS.md",
        ),
      },
    });
    expect(await texts($, "@mate:openspec/")).toEqual([
      "@mate:openspec/changes/",
      "@mate:openspec/config.yaml ",
    ]);
    expect(await texts($, "@mate:openspec/changes/")).toEqual([
      "@mate:openspec/changes/fix-login/",
    ]);
    expect(await texts($, "@mate:")).toEqual(["@mate:openspec/", "@mate:AGENTS.md "]);
  });

  test("a bare @ offers the companion gateway and top-level folders", async ($, on) => {
    world(on, {
      env: env("/c/bare"),
      disk: { "/c/bare": null },
      git: { "/c/bare": gitList("AGENTS.md", "notes/plan.md") },
    });
    expect((await ask($, "@")).suggestions).toEqual([
      { text: "@mate:", label: "mate:", description: "bare (mate companion)" },
      { text: "@mate:notes/", label: "mate:notes/", description: "bare (mate companion)" },
    ]);
    expect(await texts($, "@MA")).toEqual(["@mate:"]);
  });

  test("@mate: adds at most fifteen rows", async ($, on) => {
    const notes = Array.from({ length: 20 }, (_, i) => `note-${String(i).padStart(2, "0")}.md`);
    world(on, {
      env: env("/c/many"),
      disk: { "/c/many": null },
      git: { "/c/many": gitList(...notes) },
    });
    expect(await texts($, "@mate:note")).toHaveLength(15);
  });

  test("plain search finds path components and more than three matching files", async ($, on) => {
    world(on, {
      env: env("/c/few"),
      disk: { "/c/few": null },
      git: {
        "/c/few": gitList(
          "a/tasks.md",
          "b/tasks.md",
          "c/tasks.md",
          "d/tasks.md",
          "src-notes/apple.md",
        ),
      },
    });
    expect(await texts($, "@tasks")).toHaveLength(4);
    expect(await texts($, "@src/app")).toEqual(["@mate:src-notes/apple.md "]);
    expect(await texts($, "@src/app")).toEqual(await texts($, "@mate:src/app"));
  });

  test("paths with spaces are quoted", async ($, on) => {
    world(on, {
      env: env("/c/quote"),
      disk: { "/c/quote": null },
      git: { "/c/quote": gitList("notes/meeting notes.md") },
    });
    expect(await texts($, "@mate:notes/")).toEqual(['@"mate:notes/meeting notes.md" ']);
  });

  test("deleted files and a path git output cut short are left out", async ($, on) => {
    world(on, {
      env: env("/c/git"),
      disk: { "/c/git": null },
      git: {
        "/c/git": {
          files: ["a.md", "gone.md", "b.md", "cut-sho"],
          deleted: ["gone.md"],
          isTruncated: true,
        },
      },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:a.md ", "@mate:b.md "]);
  });

  test("gitignored files stay out", async ($, on) => {
    world(on, {
      env: env("/c/ignored"),
      disk: { "/c/ignored": null },
      git: { "/c/ignored": { files: ["a.md"], ignored: ["build.log"] } },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:a.md "]);
  });

  test("a companion git lists nothing in is walked", async ($, on) => {
    world(on, {
      env: env("/c/untracked"),
      disk: { "/c/untracked/a.md": "a" },
      git: { "/c/untracked": gitList() },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:a.md "]);
  });

  test("without git the folder is walked, links included", async ($, on) => {
    world(on, {
      env: env("/c/walk"),
      disk: {
        "/c/walk/a.md": "a",
        "/c/walk/docs/b.md": "b",
        "/c/walk/.git/HEAD": "ref",
        "/c/walk/node_modules/x/index.js": "x",
        "/c/walk/link.md": { link: "/c/walk/a.md" },
      },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:docs/", "@mate:a.md ", "@mate:link.md "]);
    expect(await texts($, "@mate:docs/")).toEqual(["@mate:docs/b.md "]);
  });

  test("git that cannot start is walked around too", async ($, on) => {
    world(on, {
      env: env("/c/nogit"),
      disk: { "/c/nogit/a.md": "a" },
      git: { "/c/nogit": "throw" },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:a.md "]);
  });

  test("the list is kept for 30 seconds, then read again", async ($, on) => {
    const { runs, clock } = world(on, {
      env: env("/c/ttl"),
      disk: { "/c/ttl": null },
      git: { "/c/ttl": gitList("a.md") },
    });
    await ask($, "@mate:");
    const first = runs.length;
    expect(first).toBeGreaterThan(0);
    await ask($, "@mate:a");
    expect(runs.length).toBe(first);
    await clock.advance(30_000);
    await ask($, "@mate:a");
    expect(runs.length).toBeGreaterThan(first);
  });

  test(
    "a lookup abandoned while git runs leaves no list behind",
    { plugins: [answersFirst] },
    async ($, on) => {
      const { clock, killGit } = world(on, {
        env: env("/c/abandon"),
        disk: { "/c/abandon/a.md": "a", "/c/abandon/ignored.log": "gitignored" },
        git: { "/c/abandon": { files: ["a.md"], stallsFirst: true } },
      });
      const abandoned = ask($, "@mate:");
      await clock.settle();
      await clock.advance(5); // the plugin above answers: the mod's lookup is abandoned
      await abandoned;
      killGit();
      await clock.settle();
      /** Not a folder walk (which would offer the gitignored file) kept for 30 seconds. */
      expect(await texts($, "@mate:")).toEqual(["@mate:a.md "]);
    },
  );

  test("secret files are never offered, whatever their letter case", async ($, on) => {
    world(on, {
      env: env("/c/secret"),
      disk: { "/c/secret": null },
      git: { "/c/secret": gitList(".env", ".ENV", "keys/ID_RSA", ".env.example", "a.md") },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:.env.example ", "@mate:a.md "]);
    expect(await texts($, "@mate:.env")).toEqual(["@mate:.env.example "]);
  });

  test("a plain session offers the rows a launch offers", async ($, on) => {
    const files = [".env", ".ENV", "keys/ID_RSA", ".env.example", "a.md", "infra/acme.tfstate"];
    const { mateRuns } = world(on, {
      sessionRoot: "/work/plain-secret",
      disk: { "/c/plain-secret": null },
      git: { "/c/plain-secret": gitList(...files) },
      mate: {
        "/work/plain-secret": { stdout: contextReply("/c/plain-secret", { deny: ["*.tfstate"] }) },
      },
    });
    /** A folder that holds only secret files is not offered either. */
    expect(await texts($, "@mate:")).toEqual(["@mate:.env.example ", "@mate:a.md "]);
    expect(await texts($, "@mate:acme")).toEqual([]);
    expect(await texts($, "@mate:.env")).toEqual(["@mate:.env.example "]);
    expect(mateRuns).toHaveLength(1);
  });

  test("a link is offered only when a mention would attach what it leads to", async ($, on) => {
    world(on, {
      env: env("/c/links"),
      disk: {
        "/c/links/a.md": "a",
        "/c/links/.env": "TOKEN=1",
        "/c/links/latest.md": { link: "/c/links/a.md" },
        "/c/links/config": { link: "/c/links/.env" },
        "/c/links/escape.md": { link: "/etc/passwd" },
        "/c/links/dangling.md": { link: "/c/links/missing.md" },
        "/etc/passwd": "root",
      },
      git: { "/c/links": gitList("a.md", "config", "dangling.md", "escape.md", "latest.md") },
    });
    expect(await texts($, "@mate:")).toEqual(["@mate:a.md ", "@mate:latest.md "]);
  });

  test("without a companion only the engine rows stay", async ($, on) => {
    const { runs } = world(on, { sessionRoot: "/work/plain" });
    expect((await ask($, "@")).suggestions).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("other tokens are left alone", async ($, on) => {
    world(on, {
      env: env("/c/other"),
      disk: { "/c/other": null },
      git: { "/c/other": gitList("a.md") },
    });
    expect((await ask($, '@"quoted')).suggestions).toEqual([]);
  });
});
