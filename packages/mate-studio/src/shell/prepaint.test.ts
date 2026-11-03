import { describe, expect, it } from "bun:test";

import {
  COMPANION_STORAGE_KEY,
  STUDIO_PREPAINT_SCRIPT,
  THEME_STORAGE_KEY,
  VAULT_TREE_STORAGE_KEY,
} from "./prepaint";

/** Runs the pre-paint script against a stored state and an address; reports what it did. */
function prepaint(stored: Record<string, string>, address: { pathname: string; search: string }) {
  const attributes = new Map<string, string>();
  const replaced: string[] = [];
  new Function("localStorage", "document", "location", STUDIO_PREPAINT_SCRIPT)(
    { getItem: (key: string) => stored[key] ?? null },
    {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    },
    { ...address, replace: (target: string) => replaced.push(target) },
  );
  return { attributes, replaced };
}

describe("the pre-paint script", () => {
  it("applies a remembered appearance before the page paints", () => {
    const { attributes } = prepaint(
      { [THEME_STORAGE_KEY]: "light" },
      { pathname: "/", search: "" },
    );
    expect(attributes.get("data-theme")).toBe("light");
  });

  it("restores a hidden tree before the page paints", () => {
    const { attributes } = prepaint(
      { [VAULT_TREE_STORAGE_KEY]: "hidden" },
      { pathname: "/vault", search: "?companion=0123456789" },
    );
    expect(attributes.get("data-vault-tree")).toBe("hidden");
  });

  it("names the remembered companion in the address of any view", () => {
    const { replaced } = prepaint(
      { [COMPANION_STORAGE_KEY]: "0123456789" },
      { pathname: "/factory", search: "?role=product-engineer" },
    );
    expect(replaced).toEqual(["/factory?role=product-engineer&companion=0123456789"]);
  });

  it("leaves a deliberate empty companion and an unknown stored value alone", () => {
    expect(
      prepaint({ [COMPANION_STORAGE_KEY]: "0123456789" }, { pathname: "/", search: "?companion=" })
        .replaced,
    ).toEqual([]);
    expect(
      prepaint({ [COMPANION_STORAGE_KEY]: "<script>" }, { pathname: "/", search: "" }).replaced,
    ).toEqual([]);
  });
});
