import { describe, expect, it } from "bun:test";

import type { StudioInventory } from "./inventory";
import {
  companionDigest,
  openFile,
  openFolder,
  parse,
  parseVaultSelection,
  refresh,
  resolveCompanion,
  type StudioSelection,
  type StudioVaultSelection,
  STUDIO_VIEWS,
  switchCompanion,
  switchRole,
  switchView,
  toFields,
  toHref,
  toSearchParams,
  withMode,
} from "./selection";

const inventory: StudioInventory = {
  companions: [
    { path: "/home/dev/.mate/companions/acme-companion", health: "ready", pairings: [] },
    { path: "/home/dev/.mate/companions/beta-companion", health: "ready", pairings: [] },
  ],
};

describe("companionDigest", () => {
  it("is short, stable, and does not carry the path", () => {
    const digest = companionDigest("/home/dev/.mate/companions/acme-companion");
    expect(digest).toBe(companionDigest("/home/dev/.mate/companions/acme-companion"));
    expect(digest).toMatch(/^[0-9a-f]{10}$/);
    expect(digest).not.toContain("acme");
  });

  it("distinguishes two companions", () => {
    expect(companionDigest("/a/acme-companion")).not.toBe(companionDigest("/b/acme-companion"));
  });
});

describe("resolveCompanion", () => {
  it("resolves a digest back to its companion", () => {
    const digest = companionDigest(inventory.companions[1]!.path);
    expect(resolveCompanion(inventory, digest)?.path).toBe(inventory.companions[1]!.path);
  });

  it("selects nothing for an unresolvable digest", () => {
    expect(resolveCompanion(inventory, "deadbeef00")).toBeNull();
    expect(resolveCompanion(inventory, null)).toBeNull();
  });

  it("selects nothing when no companion is registered", () => {
    expect(resolveCompanion({ companions: [] }, companionDigest("/a"))).toBeNull();
  });
});

const acme = companionDigest("/home/dev/.mate/companions/acme-companion");
const beta = companionDigest("/home/dev/.mate/companions/beta-companion");
const at = (query: string) => new URL(`http://localhost:1/${query}`);

describe("parse", () => {
  it("reads every view the sidebar can name", () => {
    for (const view of STUDIO_VIEWS) expect(parse(at(`?view=${view}`)).view).toBe(view);
  });

  it("reads the companion and the view", () => {
    expect(parse(at(`?companion=${acme}&view=workflow`))).toEqual({
      companionDigest: acme,
      role: "product-engineer",
      view: "workflow",
      refresh: false,
    });
  });

  it("reads an open vault file and folder", () => {
    expect(parse(at("?view=vault&path=docs%2Fnote.md&dir=docs"))).toEqual({
      companionDigest: null,
      role: "product-engineer",
      view: "vault",
      refresh: false,
      openPath: "docs/note.md",
      mode: "read",
      openDir: "docs",
    });
  });

  it("reads the mode of an open file, and only edit is a mode", () => {
    expect(parse(at("?view=vault&path=a.md&mode=edit"))).toMatchObject({ mode: "edit" });
    expect(parse(at("?view=vault&path=a.md&mode=read"))).toMatchObject({ mode: "read" });
    expect(parse(at("?view=vault&path=a.md&mode=bogus"))).toMatchObject({ mode: "read" });
    expect(parse(at("?view=vault&path=a.md"))).toMatchObject({ mode: "read" });
  });

  it("drops parameters the view does not have", () => {
    expect(parse(at(`?companion=${acme}&path=docs%2Fnote.md&dir=docs`))).toEqual({
      companionDigest: acme,
      role: "product-engineer",
      view: "dashboard",
      refresh: false,
    });
    expect(parse(at("?view=specs&path=note.md"))).toEqual({
      companionDigest: null,
      role: "product-engineer",
      view: "specs",
      refresh: false,
    });
  });

  it("selects no companion for a malformed digest", () => {
    for (const value of ["abc123", "DEADBEEF00", "deadbeef000", "../acme", "deadbeef0g"]) {
      expect(parse(at(`?companion=${encodeURIComponent(value)}`)).companionDigest).toBeNull();
    }
    expect(parse(at("?companion=deadbeef00")).companionDigest).toBe("deadbeef00");
  });

  it("parses an empty companion to no companion", () => {
    expect(parse(at("?companion="))).toEqual({
      companionDigest: null,
      role: "product-engineer",
      view: "dashboard",
      refresh: false,
    });
    expect(parse(at("?companion=%20")).companionDigest).toBeNull();
  });

  it("falls back to the Dashboard for an absent or unknown view", () => {
    expect(parse(at("")).view).toBe("dashboard");
    expect(parse(at("?view=unknown")).view).toBe("dashboard");
  });

  it("reads a refresh only from the marker the refresh control writes", () => {
    expect(parse(at("?refresh=1")).refresh).toBe(true);
    expect(parse(at("?refresh=true")).refresh).toBe(false);
    expect(parse(at("?view=workflow")).refresh).toBe(false);
  });
});

describe("parseVaultSelection", () => {
  it("implies the vault view for an API URL without one", () => {
    expect(
      parseVaultSelection(
        new URL(`http://localhost:1/api/vault/view?companion=${acme}&path=docs%2Fa.md&dir=docs`),
      ),
    ).toEqual({
      companionDigest: acme,
      role: "product-engineer",
      view: "vault",
      refresh: false,
      openPath: "docs/a.md",
      mode: "read",
      openDir: "docs",
    });
  });

  it("implies the vault view whatever the view parameter says", () => {
    expect(parseVaultSelection(at("?view=specs&refresh=1"))).toEqual({
      companionDigest: null,
      role: "product-engineer",
      view: "vault",
      refresh: true,
      openPath: null,
      mode: "read",
      openDir: null,
    });
  });
});

describe("serializing a selection", () => {
  const vault: StudioSelection = {
    companionDigest: acme,
    role: "product-engineer",
    view: "vault",
    refresh: false,
    openPath: null,
    mode: "read",
    openDir: "docs",
  };

  it("omits the defaults", () => {
    expect(
      toHref({
        companionDigest: null,
        role: "product-engineer",
        view: "dashboard",
        refresh: false,
      }),
    ).toBe("/");
    expect(
      toHref({
        companionDigest: acme,
        role: "product-engineer",
        view: "dashboard",
        refresh: false,
      }),
    ).toBe(`/?companion=${acme}`);
  });

  it("writes the addresses today's controls lead to", () => {
    expect(toHref(vault, "/api/vault/view")).toBe(
      `/api/vault/view?companion=${acme}&view=vault&dir=docs`,
    );
    expect(toHref(refresh({ ...vault, openDir: null }))).toBe(
      `/?companion=${acme}&view=vault&refresh=1`,
    );
    expect(toHref(openFile(vault, "docs/b.md"))).toBe(
      `/?companion=${acme}&view=vault&path=docs%2Fb.md`,
    );
  });

  it("writes the mode only for an open file in edit", () => {
    const editing = withMode(openFile(vault, "docs/b.md"), "edit");
    expect(toHref(editing)).toBe(`/?companion=${acme}&view=vault&path=docs%2Fb.md&mode=edit`);
    expect(toHref(withMode(editing, "read"))).toBe(
      `/?companion=${acme}&view=vault&path=docs%2Fb.md`,
    );
    expect(toHref({ ...vault, mode: "edit" })).toBe(`/?companion=${acme}&view=vault&dir=docs`);
    expect(withMode(vault, "edit")).toBe(vault);
  });

  it("starts every opened file and folder in read", () => {
    const editing = withMode(openFile(vault, "docs/b.md"), "edit");
    expect(openFile(editing, "docs/c.md").mode).toBe("read");
    expect(openFolder(editing, "docs").mode).toBe("read");
    expect(switchView(editing, "vault")).toMatchObject({ mode: "read" });
  });

  it("lists fields in the same order as the search parameters", () => {
    const refreshed = refresh(openFile(vault, "docs/b.md"));
    expect(toFields(refreshed)).toEqual([
      { name: "companion", value: acme },
      { name: "view", value: "vault" },
      { name: "path", value: "docs/b.md" },
      { name: "refresh", value: "1" },
    ]);
    expect([...toSearchParams(refreshed)]).toEqual(
      toFields(refreshed).map(({ name, value }) => [name, value]),
    );
  });
});

describe("moves", () => {
  const dashboard: StudioSelection = {
    companionDigest: acme,
    role: "product-engineer",
    view: "dashboard",
    refresh: false,
  };
  const vaultFile: StudioSelection = {
    companionDigest: acme,
    role: "product-engineer",
    view: "vault",
    refresh: true,
    openPath: "docs/a.md",
    mode: "read",
    openDir: null,
  };
  const vaultDir: StudioSelection = {
    companionDigest: acme,
    role: "product-engineer",
    view: "vault",
    refresh: false,
    openPath: null,
    mode: "read",
    openDir: "docs",
  };
  const refreshed: StudioSelection = { ...dashboard, view: "specs", refresh: true };

  const rows: [string, StudioSelection, StudioSelection][] = [
    [
      "switching view keeps the companion",
      switchView(dashboard, "workflow"),
      { companionDigest: acme, role: "product-engineer", view: "workflow", refresh: false },
    ],
    [
      "switching view drops the vault's target",
      switchView(vaultFile, "specs"),
      { companionDigest: acme, role: "product-engineer", view: "specs", refresh: false },
    ],
    [
      "switching to the vault opens nothing",
      switchView(dashboard, "vault"),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: null,
      },
    ],
    [
      "switching to the vault from the vault drops the target",
      switchView(vaultDir, "vault"),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: null,
      },
    ],
    [
      "switching view clears a refresh",
      switchView(refreshed, "dashboard"),
      { companionDigest: acme, role: "product-engineer", view: "dashboard", refresh: false },
    ],
    [
      "switching companion keeps the view and drops the vault's target",
      switchCompanion(vaultFile, beta),
      {
        companionDigest: beta,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: null,
      },
    ],
    [
      "switching companion keeps a plain view",
      switchCompanion(refreshed, beta),
      { companionDigest: beta, role: "product-engineer", view: "specs", refresh: false },
    ],
    [
      "switching to no companion keeps the view",
      switchCompanion(vaultDir, null),
      {
        companionDigest: null,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: null,
      },
    ],
    [
      "opening a file drops the open folder",
      openFile(vaultDir, "docs/b.md"),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: "docs/b.md",
        mode: "read",
        openDir: null,
      },
    ],
    [
      "opening a file clears a refresh",
      openFile(vaultFile, "docs/b.md"),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: "docs/b.md",
        mode: "read",
        openDir: null,
      },
    ],
    [
      "opening a folder drops the open file",
      openFolder(vaultFile, "docs/a"),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: "docs/a",
      },
    ],
    [
      "opening the root drops every target",
      openFolder(vaultDir, null),
      {
        companionDigest: acme,
        role: "product-engineer",
        view: "vault",
        refresh: false,
        openPath: null,
        mode: "read",
        openDir: null,
      },
    ],
    ["refreshing keeps the vault's target", refresh(vaultDir), { ...vaultDir, refresh: true }],
    ["refreshing keeps a plain view", refresh(dashboard), { ...dashboard, refresh: true }],
  ];

  for (const [name, result, expected] of rows) {
    it(name, () => {
      expect(result).toEqual(expected);
      expect(parse(new URL(toHref(result), "http://localhost:1"))).toEqual(result);
    });
  }

  it("sets refresh from the refresh move alone", () => {
    const moves = [
      switchView(refreshed, "vault"),
      switchCompanion(refreshed, beta),
      openFile(vaultFile, "x.md"),
      openFolder(vaultFile, "docs"),
    ];
    for (const moved of moves) expect(moved.refresh).toBe(false);
    expect(refresh(dashboard).refresh).toBe(true);
  });
});

describe("roles", () => {
  const ba = "business-analyst" as const;
  const pe = "product-engineer" as const;
  const vaultFile: StudioSelection = {
    companionDigest: acme,
    role: pe,
    view: "vault",
    refresh: false,
    openPath: "docs/a.md",
    mode: "edit",
    openDir: null,
  };

  it("reads an absent or unknown role as the Product Engineer", () => {
    expect(parse(at("")).role).toBe(pe);
    expect(parse(at("?role=bogus&view=workflow"))).toMatchObject({ role: pe, view: "workflow" });
    expect(parse(at(`?role=${ba}`)).role).toBe(ba);
  });

  it("falls back to the role's landing view", () => {
    expect(parse(at(`?role=${ba}`)).view).toBe("dashboard");
    for (const view of ["workflow", "skills", "unknown"]) {
      expect(parse(at(`?role=${ba}&view=${view}`)).view).toBe("dashboard");
    }
    for (const view of ["dashboard", "vault", "specs", "reports"]) {
      expect(parse(at(`?role=${ba}&view=${view}`)).view).toBe(view);
    }
  });

  it("round-trips the role, omitting the default role and the landing view", () => {
    const landing = parse(at(`?companion=${acme}&role=${ba}&view=dashboard`));
    expect(toHref(landing)).toBe(`/?companion=${acme}&role=${ba}`);
    expect(toHref(switchView(landing, "specs"))).toBe(`/?companion=${acme}&role=${ba}&view=specs`);
    const reports = switchView(landing, "reports");
    expect(parse(new URL(toHref(reports), "http://localhost:1"))).toEqual(reports);
    expect(toHref(switchRole(landing, pe))).toBe(`/?companion=${acme}`);
  });

  it("switching role keeps a shared view and the vault's target", () => {
    expect(switchRole(vaultFile, ba)).toEqual({ ...vaultFile, role: ba });
    expect(switchRole(refresh(vaultFile), ba).refresh).toBe(false);
  });

  it("switching role away from a role view lands on the new role's landing view", () => {
    const workflow = switchView(vaultFile, "workflow");
    expect(switchRole(workflow, ba)).toEqual({
      companionDigest: acme,
      role: ba,
      view: "dashboard",
      refresh: false,
    });
  });

  it("every other move keeps the role", () => {
    const analyst: StudioSelection = { ...vaultFile, role: ba };
    const moves = [
      switchView(analyst, "reports"),
      switchCompanion(analyst, beta),
      openFile(analyst, "docs/b.md"),
      openFolder(analyst, "docs"),
      withMode(analyst as StudioVaultSelection, "read"),
      refresh(analyst),
    ];
    for (const moved of moves) expect(moved.role).toBe(ba);
  });
});
