import { describe, expect, it } from "bun:test";

import type { VaultManager, VaultTreeNode } from "../../vault";
import { VAULT_FILTER_LIMIT, vaultChildren, vaultMatches, vaultView } from "./view";

const file = (path: string): VaultTreeNode => ({
  name: path.split("/").at(-1)!,
  path,
  kind: "file",
});
const dir = (path: string, children: VaultTreeNode[]): VaultTreeNode => ({
  name: path.split("/").at(-1)!,
  path,
  kind: "directory",
  children,
});

const TREE: VaultTreeNode[] = [
  file("README.md"),
  dir("docs", [
    file("docs/intro.md"),
    dir("docs/guides", [
      file("docs/guides/setup.md"),
      dir("docs/guides/deep", [file("docs/guides/deep/x.md")]),
    ]),
  ]),
  dir("acme", [file("acme/notes.md")]),
];

function manager(tree: VaultTreeNode[] = TREE, listed = true): VaultManager {
  const result = { tree, generation: 3, watching: true, warning: null };
  return {
    tree: async () => result,
    prefetch: async () => (listed ? result : null),
    open: async (_root: string, path: string) => {
      if (path.endsWith("missing.md")) throw new Error("no such markdown file");
      return { path, content: `# ${path}\n\n[up](../README.md)`, token: "acme-token" };
    },
  } as unknown as VaultManager;
}

const names = (entries: { name: string }[] | null | undefined) =>
  entries?.map((entry) => entry.name);

describe("the vault page's tree", () => {
  it("expands only the folders on the way to the open file", async () => {
    const view = await vaultView(manager(), "/acme", { path: "docs/guides/setup.md" });
    const docs = view.tree!.find((entry) => entry.name === "docs")!;
    const guides = docs.children!.find((entry) => entry.name === "guides")!;
    expect(names(guides.children)).toEqual(["deep", "setup.md"]);
    expect(guides.children!.find((entry) => entry.name === "deep")!.children).toBeUndefined();
    expect(view.tree!.find((entry) => entry.name === "acme")!.children).toBeUndefined();
  });

  it("lists folders first, then files, by name", async () => {
    const view = await vaultView(manager(), "/acme", {});
    expect(names(view.tree)).toEqual(["acme", "docs", "README.md"]);
  });

  it("names a folder the tree does not hold as missing and lists the root", async () => {
    const view = await vaultView(manager(), "/acme", { dir: "nowhere" });
    expect(view.dir).toBeNull();
    expect(view.dirMissing).toBe(true);
  });

  it("keeps what crosses to the page independent of the repository size", async () => {
    const wide = (count: number) => [
      file("README.md"),
      dir(
        "bulk",
        Array.from({ length: count }, (_, index) => file(`bulk/n${index}.md`)),
      ),
    ];
    const small = JSON.stringify((await vaultView(manager(wide(10)), "/acme", {})).tree);
    const large = JSON.stringify((await vaultView(manager(wide(20_000)), "/acme", {})).tree);
    expect(large.length).toBe(small.length);
  });

  it("answers without the tree while it is listed, and with it when asked to wait", async () => {
    expect((await vaultView(manager(TREE, false), "/acme", {})).tree).toBeNull();
    expect((await vaultView(manager(TREE, false), "/acme", { wait: true })).tree).not.toBeNull();
  });
});

describe("folders and filters", () => {
  it("gives a folder's entries when first expanded, only for listed folders", async () => {
    expect(names((await vaultChildren(manager(), "/acme", "docs"))!.entries)).toEqual([
      "guides",
      "intro.md",
    ]);
    expect(await vaultChildren(manager(), "/acme", "docs/nowhere")).toBeNull();
  });

  it("filters the whole listed tree, including unexpanded folders, and bounds the matches", async () => {
    expect(
      (await vaultMatches(manager(), "/acme", "deep")).shown.map((entry) => entry.path),
    ).toEqual(["docs/guides/deep/x.md"]);
    const many = [
      dir(
        "bulk",
        Array.from({ length: VAULT_FILTER_LIMIT + 5 }, (_, index) => file(`bulk/n${index}.md`)),
      ),
    ];
    const bounded = await vaultMatches(manager(many), "/acme", "bulk");
    expect(bounded.shown).toHaveLength(VAULT_FILTER_LIMIT);
    expect(bounded.total).toBe(VAULT_FILTER_LIMIT + 5);
  });
});

describe("an open file", () => {
  it("comes with its rendered form, links resolved on the server", async () => {
    const view = await vaultView(manager(), "/acme", { path: "docs/intro.md" });
    expect(view.open?.token).toBe("acme-token");
    expect(JSON.stringify(view.open?.markdown)).toContain('"note":"README.md"');
  });

  it("is refused in place when the vault cannot open it", async () => {
    const view = await vaultView(manager(), "/acme", { path: "docs/missing.md" });
    expect(view.open).toBeNull();
    expect(view.refusal).toBe("no such markdown file");
  });
});
