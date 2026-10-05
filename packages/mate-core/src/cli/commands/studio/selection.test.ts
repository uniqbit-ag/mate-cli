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
  STUDIO_VIEWS,
  switchCompanion,
  switchView,
  toFields,
  toHref,
  toSearchParams,
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
      view: "workflow",
      refresh: false,
    });
  });

  it("reads an open vault file and folder", () => {
    expect(parse(at("?view=vault&path=docs%2Fnote.md&dir=docs"))).toEqual({
      companionDigest: null,
      view: "vault",
      refresh: false,
      openPath: "docs/note.md",
      openDir: "docs",
    });
  });

  it("drops parameters the view does not have", () => {
    expect(parse(at(`?companion=${acme}&path=docs%2Fnote.md&dir=docs`))).toEqual({
      companionDigest: acme,
      view: "dashboard",
      refresh: false,
    });
    expect(parse(at("?view=specs&path=note.md"))).toEqual({
      companionDigest: null,
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
      view: "vault",
      refresh: false,
      openPath: "docs/a.md",
      openDir: "docs",
    });
  });

  it("implies the vault view whatever the view parameter says", () => {
    expect(parseVaultSelection(at("?view=specs&refresh=1"))).toEqual({
      companionDigest: null,
      view: "vault",
      refresh: true,
      openPath: null,
      openDir: null,
    });
  });
});

describe("serializing a selection", () => {
  const vault: StudioSelection = {
    companionDigest: acme,
    view: "vault",
    refresh: false,
    openPath: null,
    openDir: "docs",
  };

  it("omits the defaults", () => {
    expect(toHref({ companionDigest: null, view: "dashboard", refresh: false })).toBe("/");
    expect(toHref({ companionDigest: acme, view: "dashboard", refresh: false })).toBe(
      `/?companion=${acme}`,
    );
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
  const dashboard: StudioSelection = { companionDigest: acme, view: "dashboard", refresh: false };
  const vaultFile: StudioSelection = {
    companionDigest: acme,
    view: "vault",
    refresh: true,
    openPath: "docs/a.md",
    openDir: null,
  };
  const vaultDir: StudioSelection = {
    companionDigest: acme,
    view: "vault",
    refresh: false,
    openPath: null,
    openDir: "docs",
  };
  const refreshed: StudioSelection = { ...dashboard, view: "specs", refresh: true };

  const rows: [string, StudioSelection, StudioSelection][] = [
    [
      "switching view keeps the companion",
      switchView(dashboard, "workflow"),
      { companionDigest: acme, view: "workflow", refresh: false },
    ],
    [
      "switching view drops the vault's target",
      switchView(vaultFile, "specs"),
      { companionDigest: acme, view: "specs", refresh: false },
    ],
    [
      "switching to the vault opens nothing",
      switchView(dashboard, "vault"),
      { companionDigest: acme, view: "vault", refresh: false, openPath: null, openDir: null },
    ],
    [
      "switching to the vault from the vault drops the target",
      switchView(vaultDir, "vault"),
      { companionDigest: acme, view: "vault", refresh: false, openPath: null, openDir: null },
    ],
    [
      "switching view clears a refresh",
      switchView(refreshed, "dashboard"),
      { companionDigest: acme, view: "dashboard", refresh: false },
    ],
    [
      "switching companion keeps the view and drops the vault's target",
      switchCompanion(vaultFile, beta),
      { companionDigest: beta, view: "vault", refresh: false, openPath: null, openDir: null },
    ],
    [
      "switching companion keeps a plain view",
      switchCompanion(refreshed, beta),
      { companionDigest: beta, view: "specs", refresh: false },
    ],
    [
      "switching to no companion keeps the view",
      switchCompanion(vaultDir, null),
      { companionDigest: null, view: "vault", refresh: false, openPath: null, openDir: null },
    ],
    [
      "opening a file drops the open folder",
      openFile(vaultDir, "docs/b.md"),
      {
        companionDigest: acme,
        view: "vault",
        refresh: false,
        openPath: "docs/b.md",
        openDir: null,
      },
    ],
    [
      "opening a file clears a refresh",
      openFile(vaultFile, "docs/b.md"),
      {
        companionDigest: acme,
        view: "vault",
        refresh: false,
        openPath: "docs/b.md",
        openDir: null,
      },
    ],
    [
      "opening a folder drops the open file",
      openFolder(vaultFile, "docs/a"),
      { companionDigest: acme, view: "vault", refresh: false, openPath: null, openDir: "docs/a" },
    ],
    [
      "opening the root drops every target",
      openFolder(vaultDir, null),
      { companionDigest: acme, view: "vault", refresh: false, openPath: null, openDir: null },
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
