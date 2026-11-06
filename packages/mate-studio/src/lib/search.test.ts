import { describe, expect, it } from "bun:test";

import { canonicalHref, validateSpecsSearch, validateStudioSearch } from "./search";

describe("validateStudioSearch", () => {
  it("reads the canonical mode", () => {
    expect(validateStudioSearch({ studioMode: "analysis" })).toEqual({ studioMode: "analysis" });
    expect(validateStudioSearch({ studioMode: "engineering" })).toEqual({
      studioMode: "engineering",
    });
  });

  it("reads a legacy role only without a canonical mode", () => {
    expect(validateStudioSearch({ role: "business-analyst" })).toEqual({ studioMode: "analysis" });
    expect(validateStudioSearch({ role: "product-engineer" })).toEqual({
      studioMode: "engineering",
    });
    expect(validateStudioSearch({ studioMode: "analysis", role: "product-engineer" })).toEqual({
      studioMode: "analysis",
    });
  });

  it("never revives a legacy role behind an unknown canonical mode", () => {
    for (const studioMode of ["bogus", "", 3, "read"]) {
      expect(validateStudioSearch({ studioMode, role: "business-analyst" })).toEqual({});
    }
    expect(validateStudioSearch({ role: "bogus" })).toEqual({});
    expect(validateStudioSearch({ role: "constructor" })).toEqual({});
  });

  it("keeps a valid companion and drops a malformed one", () => {
    expect(validateStudioSearch({ companion: "0123456789" })).toEqual({ companion: "0123456789" });
    expect(validateStudioSearch({ companion: "../acme" })).toEqual({});
  });
});

describe("canonicalHref", () => {
  it("leaves an address naming the effective mode alone", () => {
    expect(
      canonicalHref("/", "?companion=0123456789&studioMode=analysis", "dashboard", "analysis"),
    ).toBeNull();
    expect(
      canonicalHref(
        "/vault",
        "?studioMode=engineering&path=a.md&mode=edit",
        "vault",
        "engineering",
      ),
    ).toBeNull();
  });

  it("names the effective mode where the address names none", () => {
    expect(canonicalHref("/specs", "?companion=0123456789", "specs", "engineering")).toBe(
      "/specs?companion=0123456789&studioMode=engineering",
    );
    expect(canonicalHref("/", "", "dashboard", "analysis")).toBe("/?studioMode=analysis");
  });

  it("replaces a legacy role and keeps Vault's read/edit mode and target", () => {
    expect(
      canonicalHref("/vault", "?role=business-analyst&path=a.md&mode=edit", "vault", "analysis"),
    ).toBe("/vault?path=a.md&mode=edit&studioMode=analysis");
  });

  it("replaces a mode the profile disables with the effective one", () => {
    expect(canonicalHref("/specs", "?studioMode=engineering", "specs", "analysis")).toBe(
      "/specs?studioMode=analysis",
    );
  });

  it("sends a view the effective mode is not offered to its Overview", () => {
    for (const [path, view] of [
      ["/workflow", "workflow"],
      ["/skills", "skills"],
      ["/factory", "factory"],
    ] as const) {
      expect(
        canonicalHref(
          path,
          "?companion=0123456789&studioMode=engineering&outcome=x",
          view,
          "analysis",
        ),
      ).toBe("/?companion=0123456789&studioMode=analysis");
      expect(canonicalHref(path, "?studioMode=analysis", view, "analysis")).toBe(
        "/?studioMode=analysis",
      );
    }
  });
});

describe("validateSpecsSearch", () => {
  it("keeps search and filters as text", () => {
    expect(validateSpecsSearch({ q: "login", repo: "acme/shop", area: "packages/web" })).toEqual({
      q: "login",
      repo: "acme/shop",
      area: "packages/web",
    });
  });

  it("reads values the router parsed as numbers or booleans as typed", () => {
    expect(validateSpecsSearch({ q: 2026 })).toEqual({ q: "2026" });
    expect(validateSpecsSearch({ q: true })).toEqual({ q: "true" });
  });

  it("drops blank and structured values", () => {
    expect(validateSpecsSearch({ q: "  ", repo: { a: 1 }, area: ["web"] })).toEqual({});
  });
});
