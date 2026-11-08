import { describe, expect, it } from "bun:test";

import type { StudioInventory } from "./inventory";
import {
  companionDigest,
  modePolicy,
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
  switchMode,
  switchView,
  toFields,
  toHref,
  toSearchParams,
  withMode,
  viewsFor,
} from "./selection";

const inventory: StudioInventory = {
  companions: [
    { path: "/home/dev/.mate/companions/acme-companion", health: "ready", pairings: [] },
    { path: "/home/dev/.mate/companions/beta-companion", health: "ready", pairings: [] },
  ],
};

it("offers Usage in both modes without changing the factory gate", () => {
  for (const mode of ["engineering", "analysis"] as const) {
    expect(viewsFor(mode)).toContain("usage");
    expect(
      parse(new URL(`http://studio.local/?view=usage&studioMode=${mode}`), modePolicy("standard"))
        .view,
    ).toBe("usage");
  }
});

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
  it("offers Getting Started only in Engineering without changing the landing or companion", () => {
    expect(parse(at("?view=getting-started"))).toMatchObject({
      view: "getting-started",
      companionDigest: null,
    });
    expect(parse(at("?view=getting-started&studioMode=analysis"))).toMatchObject({
      view: "dashboard",
      studioMode: "analysis",
    });
    expect(parse(at(""))).toMatchObject({ view: "dashboard" });
  });
  it("reads every view the sidebar can name", () => {
    for (const view of STUDIO_VIEWS) expect(parse(at(`?view=${view}`)).view).toBe(view);
  });

  it("reads the companion and the view", () => {
    expect(parse(at(`?companion=${acme}&view=workflow`))).toEqual({
      companionDigest: acme,
      studioMode: "engineering",
      view: "workflow",
      refresh: false,
    });
  });

  it("reads an open vault file and folder", () => {
    expect(parse(at("?view=vault&path=docs%2Fnote.md&dir=docs"))).toEqual({
      companionDigest: null,
      studioMode: "engineering",
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
      studioMode: "engineering",
      view: "dashboard",
      refresh: false,
    });
    expect(parse(at("?view=specs&path=note.md"))).toEqual({
      companionDigest: null,
      studioMode: "engineering",
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
      studioMode: "engineering",
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
      studioMode: "engineering",
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
      studioMode: "engineering",
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
    studioMode: "engineering",
    view: "vault",
    refresh: false,
    openPath: null,
    mode: "read",
    openDir: "docs",
  };

  it("omits the landing view and unset targets, never the mode", () => {
    expect(
      toHref({
        companionDigest: null,
        studioMode: "engineering",
        view: "dashboard",
        refresh: false,
      }),
    ).toBe("/?studioMode=engineering");
    expect(
      toHref({
        companionDigest: acme,
        studioMode: "engineering",
        view: "dashboard",
        refresh: false,
      }),
    ).toBe(`/?companion=${acme}&studioMode=engineering`);
  });

  it("writes the addresses today's controls lead to", () => {
    expect(toHref(vault, "/api/vault/view")).toBe(
      `/api/vault/view?companion=${acme}&studioMode=engineering&view=vault&dir=docs`,
    );
    expect(toHref(refresh({ ...vault, openDir: null }))).toBe(
      `/?companion=${acme}&studioMode=engineering&view=vault&refresh=1`,
    );
    expect(toHref(openFile(vault, "docs/b.md"))).toBe(
      `/?companion=${acme}&studioMode=engineering&view=vault&path=docs%2Fb.md`,
    );
  });

  it("writes the mode only for an open file in edit", () => {
    const editing = withMode(openFile(vault, "docs/b.md"), "edit");
    expect(toHref(editing)).toBe(
      `/?companion=${acme}&studioMode=engineering&view=vault&path=docs%2Fb.md&mode=edit`,
    );
    expect(toHref(withMode(editing, "read"))).toBe(
      `/?companion=${acme}&studioMode=engineering&view=vault&path=docs%2Fb.md`,
    );
    expect(toHref({ ...vault, mode: "edit" })).toBe(
      `/?companion=${acme}&studioMode=engineering&view=vault&dir=docs`,
    );
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
      { name: "studioMode", value: "engineering" },
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
    studioMode: "engineering",
    view: "dashboard",
    refresh: false,
  };
  const vaultFile: StudioSelection = {
    companionDigest: acme,
    studioMode: "engineering",
    view: "vault",
    refresh: true,
    openPath: "docs/a.md",
    mode: "read",
    openDir: null,
  };
  const vaultDir: StudioSelection = {
    companionDigest: acme,
    studioMode: "engineering",
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
      { companionDigest: acme, studioMode: "engineering", view: "workflow", refresh: false },
    ],
    [
      "switching view drops the vault's target",
      switchView(vaultFile, "specs"),
      { companionDigest: acme, studioMode: "engineering", view: "specs", refresh: false },
    ],
    [
      "switching to the vault opens nothing",
      switchView(dashboard, "vault"),
      {
        companionDigest: acme,
        studioMode: "engineering",
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
        studioMode: "engineering",
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
      { companionDigest: acme, studioMode: "engineering", view: "dashboard", refresh: false },
    ],
    [
      "switching companion keeps the view and drops the vault's target",
      switchCompanion(vaultFile, beta),
      {
        companionDigest: beta,
        studioMode: "engineering",
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
      { companionDigest: beta, studioMode: "engineering", view: "specs", refresh: false },
    ],
    [
      "switching to no companion keeps the view",
      switchCompanion(vaultDir, null),
      {
        companionDigest: null,
        studioMode: "engineering",
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
        studioMode: "engineering",
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
        studioMode: "engineering",
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
        studioMode: "engineering",
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
        studioMode: "engineering",
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

describe("Studio modes", () => {
  const an = "analysis" as const;
  const en = "engineering" as const;
  const appliance = modePolicy("appliance");
  const vaultFile: StudioSelection = {
    companionDigest: acme,
    studioMode: en,
    view: "vault",
    refresh: false,
    openPath: "docs/a.md",
    mode: "edit",
    openDir: null,
  };

  it("reads an absent or unknown mode as the standard default, Engineering", () => {
    expect(parse(at("")).studioMode).toBe(en);
    expect(parse(at("?studioMode=bogus&view=workflow"))).toMatchObject({
      studioMode: en,
      view: "workflow",
    });
    expect(parse(at(`?studioMode=${an}`)).studioMode).toBe(an);
  });

  it("enables both modes in the standard profile and only Analysis in the appliance", () => {
    expect(modePolicy()).toEqual({
      profile: "standard",
      enabled: [en, an],
      defaultMode: en,
    });
    expect(modePolicy("appliance")).toEqual({
      profile: "appliance",
      enabled: [an],
      defaultMode: an,
    });
    expect(Object.isFrozen(modePolicy("appliance").enabled)).toBe(true);
  });

  it("resolves every appliance request to Analysis", () => {
    for (const query of [
      "",
      "?studioMode=bogus",
      `?studioMode=${en}`,
      `?studioMode=${en}&view=workflow`,
      "?role=product-engineer",
      "?role=product-engineer&view=skills",
      "?studioMode=standard",
      "?profile=standard",
    ]) {
      expect(parse(at(query), appliance)).toMatchObject({ studioMode: an, view: "dashboard" });
    }
    expect(parseVaultSelection(at(`?studioMode=${en}`), appliance).studioMode).toBe(an);
  });

  it("reads legacy role bookmarks as aliases only without a canonical mode", () => {
    expect(parse(at("?role=business-analyst")).studioMode).toBe(an);
    expect(parse(at("?role=product-engineer")).studioMode).toBe(en);
    expect(parse(at("?role=bogus")).studioMode).toBe(en);
    expect(parse(at("?role=toString")).studioMode).toBe(en);
    expect(parse(at(`?studioMode=${an}&role=product-engineer`)).studioMode).toBe(an);
    expect(parse(at(`?studioMode=${en}&role=business-analyst`)).studioMode).toBe(en);
    // An unknown canonical value asks for none; the alias is not revived.
    expect(parse(at("?studioMode=bogus&role=business-analyst")).studioMode).toBe(en);
    expect(parse(at("?studioMode=&role=business-analyst")).studioMode).toBe(en);
  });

  it("never writes the legacy role", () => {
    const legacy = parse(at(`?companion=${acme}&role=business-analyst&view=specs`));
    expect(toHref(legacy)).toBe(`/?companion=${acme}&studioMode=${an}&view=specs`);
  });

  it("keeps Vault's read/edit mode apart from the Studio mode", () => {
    expect(parse(at(`?studioMode=${an}&view=vault&path=a.md&mode=edit`))).toMatchObject({
      studioMode: an,
      view: "vault",
      openPath: "a.md",
      mode: "edit",
    });
    expect(parse(at("?mode=analysis")).studioMode).toBe(en);
    expect(parse(at("?view=vault&path=a.md&mode=edit"), appliance)).toMatchObject({
      studioMode: an,
      mode: "edit",
    });
  });

  it("falls back to the mode's landing view", () => {
    expect(parse(at(`?studioMode=${an}`)).view).toBe("dashboard");
    for (const view of ["workflow", "skills", "factory", "unknown"]) {
      expect(parse(at(`?studioMode=${an}&view=${view}`)).view).toBe("dashboard");
    }
    for (const view of ["dashboard", "vault", "specs", "reports", "graph"]) {
      expect(parse(at(`?studioMode=${an}&view=${view}`)).view).toBe(view);
    }
  });

  it("round-trips the mode, omitting the landing view", () => {
    const landing = parse(at(`?companion=${acme}&studioMode=${an}&view=dashboard`));
    expect(toHref(landing)).toBe(`/?companion=${acme}&studioMode=${an}`);
    expect(toHref(switchView(landing, "specs"))).toBe(
      `/?companion=${acme}&studioMode=${an}&view=specs`,
    );
    const reports = switchView(landing, "reports");
    expect(parse(new URL(toHref(reports), "http://localhost:1"))).toEqual(reports);
    expect(toHref(switchMode(landing, en))).toBe(`/?companion=${acme}&studioMode=${en}`);
  });

  it("switching mode keeps a shared view and the vault's target", () => {
    expect(switchMode(vaultFile, an)).toEqual({ ...vaultFile, studioMode: an });
    expect(switchMode(refresh(vaultFile), an).refresh).toBe(false);
  });

  it("switching mode away from a mode view lands on the new mode's landing view", () => {
    const workflow = switchView(vaultFile, "workflow");
    expect(switchMode(workflow, an)).toEqual({
      companionDigest: acme,
      studioMode: an,
      view: "dashboard",
      refresh: false,
    });
  });

  it("every other move keeps the mode", () => {
    const analysis: StudioSelection = { ...vaultFile, studioMode: an };
    const moves = [
      switchView(analysis, "reports"),
      switchCompanion(analysis, beta),
      openFile(analysis, "docs/b.md"),
      openFolder(analysis, "docs"),
      withMode(analysis as StudioVaultSelection, "read"),
      refresh(analysis),
    ];
    for (const moved of moves) expect(moved.studioMode).toBe(an);
  });
});
