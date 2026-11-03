import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import {
  advanceWorkset,
  createOutcome,
  createWorkset,
  outcomeTitle,
  readWorksets,
  resolveLinkedChanges,
  resolveWorksetOf,
  resolveWorksetBranch,
  setWorksetStarted,
  worksetIdFor,
  type WorksetRecord,
  writeWorkset,
} from "./record";

let companion: string;

beforeEach(() => {
  companion = fs.mkdtempSync(path.join(os.tmpdir(), "mate-worksets-"));
});

afterEach(() => fs.rmSync(companion, { recursive: true, force: true }));

function write(id: string, body: string): void {
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.writeFileSync(path.join(companion, "worksets", `${id}.yaml`), body);
}

const fixed = () => new Date("2026-10-29T10:00:00.000Z");

describe("delivery Workset resolution", () => {
  const workset = (id: string, changes: string[], repository = "acme/web") =>
    write(id, `id: ${id}\nrepositories: [${repository}]\nchanges: ${JSON.stringify(changes)}\n`);
  const change = (name: string, repository = "acme/web") => {
    const dir = path.join(companion, "openspec/changes", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "proposal.md"),
      `---\nscopes:\n  - repository: ${repository}\n    area: .\n---\n`,
    );
  };

  test("standalone resolution writes nothing", async () => {
    expect(await resolveWorksetOf(companion, "acme-fix")).toEqual({
      id: "acme-fix",
      implicit: true,
      diagnostics: [],
    });
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
  });

  test("members and archive anchors resolve to the explicit Workset", async () => {
    workset("acme-login", ["acme-form", "2026-10-01-acme-api"]);
    for (const name of ["acme-form", "acme-api", "2026-10-01-acme-form"]) {
      expect(await resolveWorksetOf(companion, name)).toEqual({
        id: "acme-login",
        implicit: false,
        diagnostics: [],
      });
    }
  });

  test("ambiguous membership has no default", async () => {
    workset("acme-one", ["acme-fix"]);
    workset("acme-two", ["2026-10-01-acme-fix"]);
    const result = await resolveWorksetOf(companion, "acme-fix");
    expect(result.id).toBeNull();
    expect(result.diagnostics.join()).toContain("acme-one, acme-two");
  });

  test("invalid records report path and reason and suppress inference", async () => {
    write("acme-invalid", "id: wrong\n");
    const result = await resolveWorksetOf(companion, "acme-fix");
    expect(result.id).toBeNull();
    expect(result.diagnostics.join()).toContain("worksets/acme-invalid.yaml: id");
  });

  test("explicit and implicit identity collision blocks both owners and Factory", async () => {
    change("acme-login");
    workset("acme-login", ["acme-form"]);
    for (const result of [
      await resolveWorksetOf(companion, "acme-login", "acme/web"),
      await resolveWorksetOf(companion, "acme-form", "acme/web"),
      await resolveWorksetBranch(companion, "acme-login", "acme/web"),
    ]) {
      expect(result.id).toBeNull();
      expect(result.diagnostics.join()).toContain(
        "Workset acme-login and standalone change acme-login collide",
      );
    }
  });

  test("same-name membership is safe", async () => {
    change("acme-login");
    workset("acme-login", ["acme-login"]);
    expect((await resolveWorksetOf(companion, "acme-login", "acme/web")).id).toBe("acme-login");
  });

  test("different repositories do not collide", async () => {
    change("acme-login", "acme/api");
    workset("acme-login", ["acme-form"]);
    expect((await resolveWorksetOf(companion, "acme-login", "acme/api")).id).toBe("acme-login");
    expect((await resolveWorksetOf(companion, "acme-form", "acme/web")).id).toBe("acme-login");
  });
});

describe("the record", () => {
  test("is created with its shape, an empty change list and stage Clarify intent", async () => {
    await createWorkset(
      companion,
      {
        id: "acme-login",
        title: "Login with SSO",
        intent: "Engineers sign in with SSO.",
        repository: "acme/web",
      },
      fixed,
    );
    const document = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(document).toEqual({
      id: "acme-login",
      title: "Login with SSO",
      intent: "Engineers sign in with SSO.",
      repositories: ["acme/web"],
      changes: [],
      stage: "clarify-intent",
      createdAt: "2026-10-29T10:00:00.000Z",
    });
  });

  test("a duplicate identifier is refused and nothing is written", async () => {
    write("acme-login", "id: acme-login\nrepositories: [acme/web]\ntitle: original\n");
    await expect(
      createWorkset(companion, {
        id: "acme-login",
        title: "new",
        intent: "",
        repository: "acme/web",
      }),
    ).rejects.toThrow(/acme-login already exists/);
    expect(fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8")).toContain(
      "original",
    );
    expect(fs.readdirSync(path.join(companion, "worksets"))).toEqual(["acme-login.yaml"]);
  });

  test.each(["Acme", "acme/login", "acme login", "../acme"])(
    "identifier %j is refused",
    async (id) => {
      await expect(
        createWorkset(companion, { id, title: "", intent: "", repository: "acme/web" }),
      ).rejects.toThrow(/kebab-case/);
      expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    },
  );

  test("a write keeps fields Mate maintains and fields it does not know", async () => {
    write(
      "acme-login",
      "id: acme-login\nrepositories: [acme/web]\nchanges: []\nexploreStartedAt: 2026-10-29T11:00:00Z\nowner: acme-team\n",
    );
    await advanceWorkset(companion, "acme-login");
    const document = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(document.stage).toBe("explore");
    expect(document.exploreStartedAt).toBe("2026-10-29T11:00:00Z");
    expect(document.owner).toBe("acme-team");
  });
});

describe("invalid records", () => {
  test("a mismatched identifier is reported and the others are still read", async () => {
    write("acme-a", "id: acme-b\nrepositories: [acme/web]\n");
    write("acme-c", "id: acme-c\nrepositories: [acme/web]\n");
    const listing = await readWorksets(companion);
    expect(listing.worksets.map((workset) => workset.id)).toEqual(["acme-c"]);
    expect(listing.problems).toEqual([
      {
        path: path.join("worksets", "acme-a.yaml"),
        reason: 'id "acme-b" does not match the file name acme-a',
      },
    ]);
  });

  test.each([
    ["unparseable", "id: [", /cannot be read/],
    ["no repositories", "id: acme-x\nrepositories: []\n", /at least one/],
    ["bad stage", "id: acme-x\nrepositories: [acme/web]\nstage: apply\n", /stage "apply"/],
  ])("%s is reported with its reason", async (_name, body, reason) => {
    write("acme-x", body);
    const { worksets, problems } = await readWorksets(companion);
    expect(worksets).toEqual([]);
    expect(problems[0]!.reason).toMatch(reason);
  });

  test("no worksets directory is an empty listing", async () => {
    expect(await readWorksets(companion)).toEqual({ worksets: [], problems: [] });
  });
});

describe("advancing by hand", () => {
  test("goes Clarify intent → Explore change → ready, then no further", async () => {
    write("acme-login", "id: acme-login\nrepositories: [acme/web]\n");
    expect((await advanceWorkset(companion, "acme-login")).stage).toBe("explore");
    expect((await advanceWorkset(companion, "acme-login")).stage).toBe("ready");
    await expect(advanceWorkset(companion, "acme-login")).rejects.toThrow(/no further/);
  });

  test("is refused once a change is linked", async () => {
    write("acme-login", "id: acme-login\nrepositories: [acme/web]\nchanges: [acme-login-form]\n");
    await expect(advanceWorkset(companion, "acme-login")).rejects.toThrow(/linked changes/);
  });
});

describe("linked changes", () => {
  const record = (id: string, changes: string[]): WorksetRecord => ({
    id,
    title: id,
    intent: "",
    repositories: ["acme/web"],
    changes,
    stage: "clarify-intent",
    createdAt: "",
    extra: {},
  });

  test("resolve to active changes and the newest archive of a name", () => {
    const resolved = resolveLinkedChanges(
      [record("acme-a", ["acme-form", "acme-api"])],
      ["acme-api"],
      ["2026-09-01-acme-form", "2026-10-01-acme-form"],
    );
    expect(resolved.get("acme-a")).toEqual([
      { name: "acme-form", kind: "archived", anchor: "2026-10-01-acme-form" },
      { name: "acme-api", kind: "active" },
    ]);
  });

  test("an unknown change is missing", () => {
    expect(resolveLinkedChanges([record("acme-a", ["acme-gone"])], [], []).get("acme-a")).toEqual([
      { name: "acme-gone", kind: "missing" },
    ]);
  });

  test("a change claimed twice is a conflict for both Worksets", () => {
    const resolved = resolveLinkedChanges(
      [record("acme-a", ["acme-login-form"]), record("acme-b", ["acme-login-form"])],
      ["acme-login-form"],
      [],
    );
    for (const id of ["acme-a", "acme-b"]) {
      expect(resolved.get(id)).toEqual([
        { name: "acme-login-form", kind: "conflict", worksets: ["acme-a", "acme-b"] },
      ]);
    }
  });

  test("writeWorkset replaces a record atomically", async () => {
    await writeWorkset(companion, record("acme-a", []));
    expect(fs.readdirSync(path.join(companion, "worksets"))).toEqual(["acme-a.yaml"]);
  });
});

describe("started and Later", () => {
  test("a started record reads with its start time", async () => {
    write(
      "acme-login",
      "id: acme-login\nrepositories: [acme/web]\nqueuedAt: 2026-11-02T09:00:00.000Z\n",
    );
    const [record] = (await readWorksets(companion)).worksets;
    expect(record?.queuedAt).toBe("2026-11-02T09:00:00.000Z");
  });

  test("a start time that is no timestamp is reported naming queuedAt, and the others still read", async () => {
    write("acme-a", "id: acme-a\nrepositories: [acme/web]\nqueuedAt: soon\n");
    write("acme-b", "id: acme-b\nrepositories: [acme/web]\n");
    const listing = await readWorksets(companion);
    expect(listing.worksets.map((workset) => workset.id)).toEqual(["acme-b"]);
    expect(listing.problems[0]?.reason).toContain("queuedAt");
  });

  test("a record with an earlier priority reads as started and keeps the field", async () => {
    write(
      "acme-a",
      "id: acme-a\nrepositories: [acme/web]\npriority: focus\nqueuedAt: 2026-11-02T09:00:00.000Z\n",
    );
    const [record] = (await readWorksets(companion)).worksets;
    expect(record?.queuedAt).toBe("2026-11-02T09:00:00.000Z");
    await writeWorkset(companion, record!);
    const document = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-a.yaml"), "utf8"),
    );
    expect(document).toMatchObject({ priority: "focus", queuedAt: "2026-11-02T09:00:00.000Z" });
  });

  test("starting stamps queuedAt, starting again keeps it, Later clears it", async () => {
    write(
      "acme-login",
      "id: acme-login\nrepositories: [acme/web]\nlane: noise\npriority: background\n",
    );
    const monday = () => new Date("2026-11-02T09:00:00.000Z");
    const wednesday = () => new Date("2026-11-04T09:00:00.000Z");
    expect(await setWorksetStarted(companion, "acme-login", true, monday)).toMatchObject({
      queuedAt: "2026-11-02T09:00:00.000Z",
    });
    expect(await setWorksetStarted(companion, "acme-login", true, wednesday)).toMatchObject({
      queuedAt: "2026-11-02T09:00:00.000Z",
    });
    const read = () =>
      parse(fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"));
    expect(read().lane).toBeUndefined();
    expect(read().priority).toBeUndefined();
    await setWorksetStarted(companion, "acme-login", false);
    expect(read().queuedAt).toBeUndefined();
  });
});

describe("outcomes", () => {
  test("the identifier is the kebab-case title, suffixed while taken", () => {
    expect(worksetIdFor("Login with SSO", new Set())).toBe("login-with-sso");
    expect(worksetIdFor("Login with SSO", new Set(["login-with-sso"]))).toBe("login-with-sso-2");
    expect(worksetIdFor("Login with SSO", new Set(["login-with-sso", "login-with-sso-2"]))).toBe(
      "login-with-sso-3",
    );
    expect(worksetIdFor("Über die Größe", new Set())).toBe("uber-die-grosse");
    expect(worksetIdFor("!!!", new Set())).toBeNull();
    expect(worksetIdFor("a".repeat(80), new Set())?.length).toBe(63);
  });

  test("the title is the first sentence or line, cut at a word boundary", () => {
    expect(outcomeTitle("Make onboarding easier. Fewer steps, keep auth working.")).toBe(
      "Make onboarding easier",
    );
    expect(outcomeTitle("  Export to CSV\nwith headers")).toBe("Export to CSV");
    const long = outcomeTitle(`${"word ".repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith("word")).toBe(true);
  });

  test("an outcome text creates a Workset for the only linked repository", async () => {
    const text = "Make onboarding easier. Fewer steps, keep auth working.";
    const record = await createOutcome(companion, { text }, ["acme/web"], fixed);
    expect(record).toMatchObject({
      id: "make-onboarding-easier",
      title: "Make onboarding easier",
      intent: text,
      repositories: ["acme/web"],
      stage: "clarify-intent",
    });
    expect(record.queuedAt).toBeUndefined();
  });

  test("a started outcome is written with its start time", async () => {
    const record = await createOutcome(
      companion,
      { text: "Acme export", start: true },
      ["acme/web"],
      fixed,
    );
    expect(record).toMatchObject({ queuedAt: "2026-10-29T10:00:00.000Z" });
    const document = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-export.yaml"), "utf8"),
    );
    expect(document.queuedAt).toBe("2026-10-29T10:00:00.000Z");
  });

  test("a taken identifier gets the next suffix", async () => {
    write("login-with-sso", "id: login-with-sso\nrepositories: [acme/web]\n");
    const record = await createOutcome(companion, { text: "Login with SSO" }, ["acme/web"]);
    expect(record.id).toBe("login-with-sso-2");
  });

  test("several repositories and none chosen is refused and nothing is written", async () => {
    await expect(
      createOutcome(companion, { text: "Acme export" }, ["acme/web", "acme/api"]),
    ).rejects.toThrow("choose the Working Repository");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
  });

  test("a text without letters or digits is refused", async () => {
    await expect(createOutcome(companion, { text: "???" }, ["acme/web"])).rejects.toThrow(
      "gives no title",
    );
  });
});
