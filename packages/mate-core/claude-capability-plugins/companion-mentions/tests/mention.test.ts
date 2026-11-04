import { describe, expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { PromptMentionInput } from "claude-code";
import { type PolicyOptions, contextReply, policyJson } from "./policy.ts";
import { type Setup, world } from "./world.ts";

const ROOT = "/companions/app";

const setup: Setup = {
  env: { MATE_ARTIFACT_PATH: ROOT, MATE_POLICY_JSON: policyJson({ deny: ["*.tfstate"] }) },
  disk: {
    [`${ROOT}/AGENTS.md`]: "agents",
    [`${ROOT}/openspec/config.yaml`]: "config",
    [`${ROOT}/openspec/changes/fix-login/tasks.md`]: "tasks",
    [`${ROOT}/empty`]: null,
    [`${ROOT}/.env`]: "TOKEN=1",
    [`${ROOT}/.ENV`]: "TOKEN=2",
    [`${ROOT}/.env.example`]: "TOKEN=",
    [`${ROOT}/infra/acme.tfstate`]: "{}",
    [`${ROOT}/notes.md`]: { link: `${ROOT}/.env` },
    [`${ROOT}/escape.md`]: { link: "/etc/passwd" },
    [`${ROOT}/dangling.md`]: { link: `${ROOT}/missing.md` },
    [`${ROOT}/latest.md`]: { link: `${ROOT}/AGENTS.md` },
    [`${ROOT}/sub/.env`]: { link: `${ROOT}/AGENTS.md` },
    [`${ROOT}/vault/.git/HEAD`]: "ref",
    [`${ROOT}/vault/.env`]: "TOKEN=3",
    [`${ROOT}/vault/keys/id.txt`]: "key",
    [`${ROOT}/vault/plan.md`]: "plan",
    [`${ROOT}/sock`]: { other: true },
    [`${ROOT}/locked/a.md`]: "a",
    "/etc/passwd": "root",
    "/work/app/y.md": "working repo",
  },
};

function mention($: Engine, text: string, lines?: { offset: number; limit: number }) {
  const input: PromptMentionInput = { mention: text, path: `/work/app/${text}`, ...lines };
  return $.prompt.mention(input);
}

describe("@mate: mentions", () => {
  test("read the file from the companion and name its path", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:openspec/config.yaml");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/openspec/config.yaml`]);
    expect(result).toEqual({
      type: "file",
      context: [
        `@mate:openspec/config.yaml is the file ${ROOT}/openspec/config.yaml in the mate companion repo.`,
      ],
    });
  });

  test("a link inside the companion attaches the file it leads to", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:latest.md");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/AGENTS.md`]);
    expect(result.context).toEqual([
      `@mate:latest.md is the file ${ROOT}/AGENTS.md in the mate companion repo.`,
    ]);
  });

  test("keep what the engine's own read adds", async ($, on) => {
    world(on, { ...setup, mentionResult: { type: "file", context: ["read by the engine"] } });
    expect((await mention($, "mate:AGENTS.md")).context).toEqual([
      "read by the engine",
      `@mate:AGENTS.md is the file ${ROOT}/AGENTS.md in the mate companion repo.`,
    ]);
  });

  test("keep the line range", async ($, on) => {
    const { reads } = world(on, setup);
    await mention($, "mate:openspec/config.yaml#L2-4", { offset: 2, limit: 3 });
    expect(reads).toEqual([{ path: `${ROOT}/openspec/config.yaml`, offset: 2, limit: 3 }]);
  });

  test("a folder lists what it holds", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:openspec");
    expect(reads).toEqual([]);
    expect(result).toEqual({
      type: null,
      context: [
        `@mate:openspec is the folder ${ROOT}/openspec in the mate companion repo. It holds:\n- changes/\n- config.yaml`,
      ],
    });
    expect((await mention($, "mate:empty")).context?.[0]).toEndWith("It is empty.");
  });

  test("a folder's list leaves out .git and secret files", async ($, on) => {
    world(on, setup);
    expect((await mention($, "mate:vault")).context?.[0]).toBe(
      `@mate:vault is the folder ${ROOT}/vault in the mate companion repo. It holds:\n- keys/\n- plan.md`,
    );
  });

  test("a secret folder is refused, by name or link, and left out of its parent's list", async ($, on) => {
    const root = "/companions/private";
    world(on, {
      env: { MATE_ARTIFACT_PATH: root, MATE_POLICY_JSON: policyJson({ deny: ["private/"] }) },
      disk: {
        [`${root}/box/private/nested/a.md`]: "a",
        [`${root}/box/plan.md`]: "plan",
        [`${root}/box/alias`]: { link: `${root}/box/private` },
      },
    });
    for (const named of ["mate:box/private", "mate:box/alias"]) {
      expect((await mention($, named)).context?.[0]).toContain("secret folders (`private/`)");
    }
    expect((await mention($, "mate:box")).context?.[0]).toBe(
      `@mate:box is the folder ${root}/box in the mate companion repo. It holds:\n- plan.md`,
    );
  });

  test("a folder's list judges each linked entry where it leads", async ($, on) => {
    const root = "/companions/linked";
    world(on, {
      env: { MATE_ARTIFACT_PATH: root, MATE_POLICY_JSON: policyJson({ deny: ["secrets/**"] }) },
      disk: {
        [`${root}/secrets/customer-production.json`]: "{}",
        [`${root}/AGENTS.md`]: "agents",
        [`${root}/docs/a.md`]: "a",
        [`${root}/vault/customer-production.json`]: {
          link: `${root}/secrets/customer-production.json`,
        },
        [`${root}/vault/outside.txt`]: { link: "/etc/passwd" },
        [`${root}/vault/dangling.md`]: { link: `${root}/missing.md` },
        [`${root}/vault/latest.md`]: { link: `${root}/AGENTS.md` },
        [`${root}/vault/docs`]: { link: `${root}/docs` },
        [`${root}/vault/plan.md`]: "plan",
        "/etc/passwd": "root",
      },
    });
    expect((await mention($, "mate:vault/customer-production.json")).context?.[0]).toContain(
      "secret files (`secrets/**`)",
    );
    expect((await mention($, "mate:vault")).context?.[0]).toBe(
      `@mate:vault is the folder ${root}/vault in the mate companion repo. It holds:\n- docs/\n- latest.md\n- plan.md`,
    );
  });

  test("a linked folder is listed where its check looked, even when the link moves", async ($, on) => {
    const root = "/companions/moving";
    world(on, {
      env: { MATE_ARTIFACT_PATH: root, MATE_POLICY_JSON: policyJson({ deny: ["secrets/**"] }) },
      disk: {
        [`${root}/docs/a.md`]: "a",
        [`${root}/secrets/customer-production.json`]: "{}",
        [`${root}/shelf`]: { link: `${root}/docs` },
      },
      afterStat: (path, disk) => {
        if (path === `${root}/shelf`) disk[path] = { link: `${root}/secrets` };
      },
    });
    const note = (await mention($, "mate:shelf")).context?.[0] ?? "";
    expect(note).toContain("- a.md");
    expect(note).not.toContain("customer-production.json");
  });

  test("a folder lists at most 200 names, then how many more", async ($, on) => {
    const disk = { ...setup.disk };
    for (let i = 0; i < 203; i++) disk[`${ROOT}/many/n${String(i).padStart(3, "0")}.md`] = "";
    world(on, { ...setup, disk });
    const note = (await mention($, "mate:many")).context?.[0] ?? "";
    expect(note.split("\n").filter((line) => line.startsWith("- n"))).toHaveLength(200);
    expect(note).toEndWith("- ... and 3 more");
  });

  test("something neither file nor folder says so", async ($, on) => {
    const { reads } = world(on, setup);
    expect((await mention($, "mate:sock")).context?.[0]).toBe(
      `@mate:sock was not attached: ${ROOT}/sock is not a file or folder.`,
    );
    expect(reads).toEqual([]);
  });

  test("a lookup that fails says so", async ($, on) => {
    const { reads } = world(on, { ...setup, unlistable: [`${ROOT}/locked`] });
    expect((await mention($, "mate:locked")).context?.[0]).toStartWith(
      "@mate:locked was not attached: looking it up in the mate companion repo failed",
    );
    expect(reads).toEqual([]);
  });

  test("a missing file says so", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:nope.md");
    expect(reads).toEqual([]);
    expect(result.context?.[0]).toBe(
      `@mate:nope.md was not found in the mate companion repo (${ROOT}).`,
    );
  });

  test("a link leading outside is refused, and Claude is told", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:escape.md");
    expect(reads).toEqual([]);
    expect(result.deny).toBeUndefined();
    expect(result.context?.[0]).toContain("outside the mate companion repo");
  });

  test("a link that leads nowhere says so", async ($, on) => {
    world(on, setup);
    expect((await mention($, "mate:dangling.md")).context?.[0]).toContain("leads nowhere");
  });

  test("`..` never reads the working repo", async ($, on) => {
    const { reads } = world(on, setup);
    const result = await mention($, "mate:x/../y.md");
    expect(reads).toEqual([]);
    expect(result.type).toBeNull();
    expect(result.context?.[0]).toContain("`..`");
  });

  test("secret files are not attached, by the name used or where a link leads", async ($, on) => {
    const { reads } = world(on, setup);
    for (const name of ["mate:.env", "mate:notes.md", "mate:sub/.env"]) {
      expect((await mention($, name)).context?.[0]).toBe(
        `@${name} was not attached: mate keeps secret files (\`.env\`) away from Claude.`,
      );
    }
    expect(reads).toEqual([]);
  });

  test("a secret file is one whatever its letter case", async ($, on) => {
    const { reads } = world(on, setup);
    expect((await mention($, "mate:.ENV")).context?.[0]).toContain("secret files (`.env`)");
    expect(reads).toEqual([]);
  });

  test("the companion's own secret patterns count", async ($, on) => {
    const { reads } = world(on, setup);
    expect((await mention($, "mate:infra/acme.tfstate")).context?.[0]).toContain(
      "secret files (`*.tfstate`)",
    );
    expect(reads).toEqual([]);
  });

  test("an allowed example file is attached", async ($, on) => {
    const { reads } = world(on, setup);
    await mention($, "mate:.env.example");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/.env.example`]);
  });

  test("with guardrails off a secret file is attached", async ($, on) => {
    const optedOut: PolicyOptions = { guardrails: false };
    const { reads } = world(on, {
      ...setup,
      env: { MATE_ARTIFACT_PATH: ROOT, MATE_POLICY_JSON: policyJson(optedOut) },
    });
    await mention($, "mate:.env");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/.env`]);
  });

  test("folders above the companion do not count against a path pattern", async ($, on) => {
    const root = "/work/secrets/companion";
    const { reads } = world(on, {
      env: { MATE_ARTIFACT_PATH: root, MATE_POLICY_JSON: policyJson({ deny: ["secrets/**"] }) },
      disk: { [`${root}/README.md`]: "readme", [`${root}/secrets/token.txt`]: "token" },
    });
    await mention($, "mate:README.md");
    expect(reads.map((read) => read.path)).toEqual([`${root}/README.md`]);
    expect((await mention($, "mate:secrets/token.txt")).context?.[0]).toContain(
      "secret files (`secrets/**`)",
    );
  });

  test("the engine's own refusal stands", async ($, on) => {
    world(on, { ...setup, mentionResult: { deny: "denied by a Read rule" } });
    expect(await mention($, "mate:AGENTS.md")).toEqual({ deny: "denied by a Read rule" });
  });

  test("other mentions pass through untouched", async ($, on) => {
    const { reads } = world(on, setup);
    await mention($, "src/app.ts");
    expect(reads.map((read) => read.path)).toEqual(["/work/app/src/app.ts"]);
  });

  test("without a companion Claude is told why", async ($, on) => {
    const { reads } = world(on, { sessionRoot: "/work/plain" });
    const result = await mention($, "mate:AGENTS.md");
    expect(reads).toEqual([]);
    expect(result.context?.[0]).toContain("no mate companion");
    expect(result.context?.[0]).toContain("`mate doctor`");
  });
});

describe("@mate: mentions in a plain session", () => {
  /** The same companion as `setup`, named by Mate instead of the launch. */
  const plain: Setup = {
    disk: setup.disk,
    mate: { "/work/app": { stdout: contextReply(ROOT, { deny: ["*.tfstate"] }) } },
  };

  test("attach a file as a launch does", async ($, on) => {
    const { reads, mateRuns } = world(on, plain);
    const result = await mention($, "mate:openspec/config.yaml");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/openspec/config.yaml`]);
    expect(result.context).toEqual([
      `@mate:openspec/config.yaml is the file ${ROOT}/openspec/config.yaml in the mate companion repo.`,
    ]);
    expect(mateRuns).toHaveLength(1);
  });

  test("refuse the secret files a launch refuses", async ($, on) => {
    const { reads } = world(on, plain);
    for (const [name, pattern] of [
      ["mate:.env", ".env"],
      ["mate:.ENV", ".env"],
      ["mate:notes.md", ".env"],
      ["mate:infra/acme.tfstate", "*.tfstate"],
    ] as const) {
      expect((await mention($, name)).context).toEqual([
        `@${name} was not attached: mate keeps secret files (\`${pattern}\`) away from Claude.`,
      ]);
    }
    expect(reads).toEqual([]);
  });

  test("attach an allowed example file", async ($, on) => {
    const { reads } = world(on, plain);
    await mention($, "mate:.env.example");
    expect(reads.map((read) => read.path)).toEqual([`${ROOT}/.env.example`]);
  });

  test("leave secret files out of a folder's list", async ($, on) => {
    world(on, plain);
    const listed = (await mention($, "mate:vault/")).context?.[0] ?? "";
    expect(listed).toContain("- plan.md");
    expect(listed).not.toContain(".env");
  });
});
