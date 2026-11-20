import { describe, expect, test } from "bun:test";

import { groupClaim, parseOwner, serializeOwner } from "./claims";

const owner = { id: "dev@acme.test", label: "Acme Developer" };

describe("owner files", () => {
  test("round-trips an owner; a missing file is unclaimed", () => {
    expect(parseOwner(serializeOwner(owner))).toEqual({ status: "owned", owner });
    expect(parseOwner(null)).toEqual({ status: "absent" });
  });

  test("an owner needs an email id and a name", () => {
    expect(parseOwner("owner: { id: nobody, label: x }\n").status).toBe("invalid");
    expect(parseOwner("owner: { id: dev@acme.test, label: '' }\n").status).toBe("invalid");
    expect(parseOwner(": :\n").status).toBe("invalid");
  });

  test("ids compare case-insensitively", () => {
    expect(parseOwner("owner: { id: Dev@Acme.test, label: Acme }\n")).toEqual({
      status: "owned",
      owner: { id: "dev@acme.test", label: "Acme" },
    });
  });
});

describe("a group's claim", () => {
  const owned = { status: "owned" as const, owner };
  test("every member names the same owner", () => {
    expect(groupClaim([owned, owned])).toEqual({ kind: "owned", owner });
    expect(groupClaim([{ status: "absent" }, { status: "absent" }])).toEqual({ kind: "none" });
  });

  test("equal labels with other emails, or a partly claimed group, conflict", () => {
    const other = { status: "owned" as const, owner: { id: "x@acme.test", label: owner.label } };
    expect(groupClaim([owned, other]).kind).toBe("conflict");
    expect(groupClaim([owned, { status: "absent" }]).kind).toBe("conflict");
  });
});
