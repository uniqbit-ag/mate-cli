import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import {
  advanceWorkset,
  createWorkset,
  readWorksets,
  resolveLinkedChanges,
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
