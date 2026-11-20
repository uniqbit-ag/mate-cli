import { describe, expect, test } from "bun:test";

import { branchesFrom, dependsOnFrom, deriveGroups, worksetIdOfBranch } from "./groups";

const change = (name: string, dependsOn: string[] = [], branches: string[] = []) => ({
  name,
  dependsOn,
  branches,
});

describe("derived Worksets", () => {
  test("a change on its own is its own Workset", () => {
    expect(deriveGroups([change("acme-login")])).toEqual([
      { id: "acme-login", members: ["acme-login"], diagnostics: [] },
    ]);
  });

  test("slices linked by dependsOn form one group named after the first in dependency order", () => {
    const [group] = deriveGroups([
      change("acme-login-ui", ["acme-login-api"]),
      change("acme-login-api"),
    ]);
    expect(group).toEqual({
      id: "acme-login-api",
      members: ["acme-login-api", "acme-login-ui"],
      diagnostics: [],
    });
  });

  test("a dependency recording another Delivery Branch merges separately", () => {
    const groups = deriveGroups([
      change("acme-login-ui", ["acme-login-api"], ["workset/acme-ui"]),
      change("acme-login-api", [], ["workset/acme-api"]),
    ]);
    expect(groups.map((group) => group.members)).toEqual([["acme-login-api"], ["acme-login-ui"]]);
    expect(groups.map((group) => group.id)).toEqual(["acme-api", "acme-ui"]);
  });

  test("changes on the same Delivery Branch are one group named by it, ticket stripped", () => {
    const [group] = deriveGroups([
      change("acme-a", [], ["workset/ABC-12-acme-login"]),
      change("acme-b", [], ["workset/ABC-12-acme-login"]),
    ]);
    expect(group?.id).toBe("acme-login");
    expect(group?.members).toEqual(["acme-a", "acme-b"]);
  });

  test("a local record joins the changes it lists and names the group", () => {
    const [group] = deriveGroups(
      [change("acme-a"), change("acme-b")],
      new Map([["acme-idea", ["acme-a", "acme-b"]]]),
    );
    expect(group).toEqual({
      id: "acme-idea",
      members: ["acme-a", "acme-b"],
      record: "acme-idea",
      diagnostics: [],
    });
  });

  test("two records listing one change are diagnosed", () => {
    const [group] = deriveGroups(
      [change("acme-a")],
      new Map([
        ["acme-one", ["acme-a"]],
        ["acme-two", ["acme-a"]],
      ]),
    );
    expect(group?.diagnostics).toEqual(["listed by several Worksets: acme-one, acme-two"]);
  });

  test("branch names carry the Workset id", () => {
    expect(worksetIdOfBranch("workset/acme-login")).toBe("acme-login");
    expect(worksetIdOfBranch("workset/ABC-123-acme-login")).toBe("acme-login");
    expect(worksetIdOfBranch("change/acme-login")).toBeNull();
  });

  test("dependsOn and branches are read from planning and delivery files", () => {
    expect(
      dependsOnFrom([null, "---\ndependsOn: [acme-a]\n---\n", "---\ndependsOn: [x]\n---\n"]),
    ).toEqual(["acme-a"]);
    expect(
      branchesFrom(
        "version: 1\nchange: acme\ndeliveries:\n  - repository: acme/web\n    branch: workset/acme\n",
      ),
    ).toEqual(["workset/acme"]);
    expect(branchesFrom("deliveries: []\n")).toEqual([]);
    expect(branchesFrom(": not yaml")).toEqual([]);
  });
});
