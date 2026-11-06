import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSpecGraph,
  createSpecGraphCache,
  deriveSpecGraph,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_STRIDE,
  type GraphArchiveSource,
  type GraphSpecSource,
  specGraphFingerprint,
  type StudioGraphEdgeKind,
  type StudioSpecGraph,
} from "./graph";

function spec(
  capability: string,
  repository?: string,
  areas?: string[],
  body = "",
): GraphSpecSource {
  const header = ["---", "type: spec", `capability: ${capability}`];
  if (repository) header.push(`repository: ${repository}`);
  if (areas) header.push(`areas: [${areas.join(", ")}]`);
  return { capability, content: [...header, "---", "", body].join("\n") };
}

function archive(
  anchor: string,
  capabilities: string[],
  entries = ["tasks.md"],
): GraphArchiveSource {
  return { anchor, capabilities, entries };
}

/** Edges as readable `[source id, target id, kind, weight]` tuples. */
function edgesOf(graph: StudioSpecGraph, kind?: StudioGraphEdgeKind) {
  const out: [string, string, StudioGraphEdgeKind, number][] = [];
  for (let index = 0; index < graph.edges.length; index += GRAPH_EDGE_STRIDE) {
    const [source, target, code, weight] = graph.edges.slice(index, index + GRAPH_EDGE_STRIDE);
    const edgeKind = GRAPH_EDGE_KINDS[code];
    if (!kind || edgeKind === kind) {
      out.push([graph.nodes[source].id, graph.nodes[target].id, edgeKind, weight]);
    }
  }
  return out.toSorted((a, b) => (a.join("|") < b.join("|") ? -1 : 1));
}

describe("deriveSpecGraph nodes and binding", () => {
  test("keeps equal Area paths of two repositories apart", () => {
    const graph = deriveSpecGraph(
      [
        spec("acme-web", "acme/web", ["packages/acme"]),
        spec("acme-api", "acme/api", ["packages/acme"]),
      ],
      [],
    );
    expect(graph.nodes.filter((node) => node.kind === "area").map((node) => node.id)).toEqual([
      "area:acme/api#packages/acme",
      "area:acme/web#packages/acme",
    ]);
    expect(edgesOf(graph, "in")).toEqual([
      ["area:acme/api#packages/acme", "repo:acme/api", "in", 1],
      ["area:acme/web#packages/acme", "repo:acme/web", "in", 1],
    ]);
  });

  test("binds a spec to each of its Areas, each Area once to its repository", () => {
    const graph = deriveSpecGraph(
      [
        spec("acme-auth", "acme/web", ["packages/acme", "apps/docs"]),
        spec("acme-session", "acme/web", ["packages/acme"]),
      ],
      [],
    );
    expect(edgesOf(graph, "binds")).toEqual([
      ["spec:acme-auth", "area:acme/web#apps/docs", "binds", 1],
      ["spec:acme-auth", "area:acme/web#packages/acme", "binds", 1],
      ["spec:acme-session", "area:acme/web#packages/acme", "binds", 1],
    ]);
    expect(edgesOf(graph, "in")).toHaveLength(2);
  });

  test("labels the repository-root Area", () => {
    const graph = deriveSpecGraph([spec("acme", "acme/web", ["."])], []);
    expect(graph.nodes.find((node) => node.kind === "area")?.label).toBe("Repository root");
  });

  test("reports a spec without repository or areas as unbound", () => {
    const graph = deriveSpecGraph(
      [
        spec("acme-a", undefined, ["packages/acme"]),
        spec("acme-b", "acme/web"),
        spec("acme-c", "acme/web", ["x"]),
      ],
      [],
    );
    expect(graph.unbound).toEqual(["acme-a", "acme-b"]);
    expect(edgesOf(graph, "binds")).toEqual([["spec:acme-c", "area:acme/web#x", "binds", 1]]);
  });

  test("binds scopes pairs, inline Area markers and a BOM-prefixed spec as the Specs view does", () => {
    const graph = deriveSpecGraph(
      [
        {
          capability: "acme-a",
          content: "---\nscopes:\n  - repository: acme/web\n    area: x\n---\n\n**Area:** `y`\n",
        },
        { capability: "acme-b", content: "\uFEFF" + spec("acme-b", "acme/web", ["x"]).content },
        {
          capability: "acme-c",
          content: spec("acme-c", "acme/web", undefined, "**Area:** `z`").content,
        },
      ],
      [],
    );
    expect(graph.unbound).toEqual([]);
    expect(edgesOf(graph, "binds")).toEqual([
      ["spec:acme-a", "area:acme/web#x", "binds", 1],
      ["spec:acme-a", "area:acme/web#y", "binds", 1],
      ["spec:acme-b", "area:acme/web#x", "binds", 1],
      ["spec:acme-c", "area:acme/web#z", "binds", 1],
    ]);
  });
});

describe("deriveSpecGraph mentions", () => {
  const known = (body: string) =>
    deriveSpecGraph(
      [spec("acme-auth", "acme/web", ["a"], body), spec("acme-session"), spec("acme/billing")],
      [],
    );

  test("resolves a wiki link by capability id", () => {
    const graph = known(
      "See [[specs/acme-session/spec]] and [[openspec/specs/acme/billing/spec.md#Purpose|billing]].",
    );
    expect(edgesOf(graph, "mentions")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "mentions", 1],
      ["spec:acme-auth", "spec:acme/billing", "mentions", 1],
    ]);
  });

  test("resolves a relative markdown link", () => {
    const graph = known("See [session](../acme-session/spec.md).");
    expect(edgesOf(graph, "mentions")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "mentions", 1],
    ]);
  });

  test("resolves site-absolute and URL links by their specs/ tail", () => {
    const graph = known(
      "See [a](/openspec/specs/acme-session/spec.md) and [b](https://example.com/o/r/blob/main/openspec/specs/acme/billing/spec.md).",
    );
    expect(edgesOf(graph, "mentions")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "mentions", 1],
      ["spec:acme-auth", "spec:acme/billing", "mentions", 1],
    ]);
    expect(graph.broken).toEqual([]);
  });

  test("resolves a backticked id, once, and ignores ordinary words and itself", () => {
    const graph = known(
      "Uses `acme-session` twice: `acme-session`, runs `bun test`, is `acme-auth`.",
    );
    expect(edgesOf(graph, "mentions")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "mentions", 1],
    ]);
    expect(graph.broken).toEqual([]);
  });

  test("reports an explicit link to an unknown capability as broken", () => {
    const graph = known("See [[specs/acme-gone/spec]] and [gone](../acme-lost/spec.md).");
    expect(edgesOf(graph, "mentions")).toEqual([]);
    expect(graph.broken).toEqual([
      { from: "acme-auth", target: "acme-gone" },
      { from: "acme-auth", target: "acme-lost" },
    ]);
  });
});

describe("deriveSpecGraph archives", () => {
  const specs = [spec("acme-auth"), spec("acme-session"), spec("acme-cart")];

  test("weights a co-change edge by the archives naming both", () => {
    const graph = deriveSpecGraph(specs, [
      archive("2026-01-01-one", ["acme-auth", "acme-session"]),
      archive("2026-02-01-two", ["acme-session", "acme-auth", "acme-cart"]),
    ]);
    expect(edgesOf(graph, "co-change")).toEqual([
      ["spec:acme-auth", "spec:acme-cart", "co-change", 1],
      ["spec:acme-auth", "spec:acme-session", "co-change", 2],
      ["spec:acme-cart", "spec:acme-session", "co-change", 1],
    ]);
  });

  test("ignores removed capabilities and undated directories", () => {
    const graph = deriveSpecGraph(specs, [
      archive("2026-01-01-one", ["acme-auth", "acme-gone"]),
      archive("scratch", ["acme-auth", "acme-session"]),
    ]);
    expect(edgesOf(graph, "co-change")).toEqual([]);
    expect(graph.nodes.some((node) => node.id === "spec:acme-gone")).toBe(false);
    expect(graph.archives.map((entry) => entry.anchor)).toEqual(["2026-01-01-one"]);
  });

  test("lists history newest first with only known artifacts", () => {
    const graph = deriveSpecGraph(specs, [
      archive(
        "2026-01-01-old",
        ["acme-auth"],
        ["proposal.md", "design.md", "tasks.md", "shot.png"],
      ),
      archive("2026-03-01-new", ["acme-auth"], ["tasks.md", "build.log", "verify.ts"]),
      archive("2026-02-01-other", ["acme-cart"], ["tasks.md"]),
    ]);
    const auth = graph.nodes.findIndex((node) => node.id === "spec:acme-auth");
    expect(graph.history[auth].map((index) => graph.archives[index])).toEqual([
      { anchor: "2026-03-01-new", name: "new", archivedOn: "2026-03-01", artifacts: ["tasks.md"] },
      {
        anchor: "2026-01-01-old",
        name: "old",
        archivedOn: "2026-01-01",
        artifacts: ["proposal.md", "design.md", "tasks.md"],
      },
    ]);
  });
});

describe("deriveSpecGraph at scale", () => {
  test("derives about 20k nodes and 100k edges quickly and compactly", () => {
    const count = 18_000;
    const specs = Array.from({ length: count }, (_, index) =>
      spec(
        `acme-${index}`,
        `acme/r${index % 5}`,
        [`packages/a${index % 2000}`],
        `\`acme-${(index * 7) % count}\` [[specs/acme-${(index * 13) % count}/spec]]`,
      ),
    );
    const archives = Array.from({ length: 20_000 }, (_, index) =>
      archive(
        `2026-01-${String(1 + (index % 28)).padStart(2, "0")}-c${index}`,
        [0, 1, 2, 3].map((offset) => `acme-${(index * 31 + offset * 977) % count}`),
      ),
    );

    const started = performance.now();
    const graph = deriveSpecGraph(specs, archives);
    const elapsed = performance.now() - started;

    expect(graph.nodes.length).toBeGreaterThan(19_000);
    expect(graph.edges.length / GRAPH_EDGE_STRIDE).toBeGreaterThan(100_000);
    // Measured at about 0.5 s and 5.7 MB; the bounds leave room for slower machines.
    expect(elapsed).toBeLessThan(5_000);
    expect(JSON.stringify(graph).length).toBeLessThan(8_000_000);
  });
});

describe("createSpecGraphCache", () => {
  const empty: StudioSpecGraph = {
    nodes: [],
    edges: [],
    archives: [],
    history: [],
    unbound: [],
    broken: [],
  };

  test("builds an unchanged companion once and rebuilds when its fingerprint changes", async () => {
    let builds = 0;
    let basis = "one";
    const cache = createSpecGraphCache(
      async () => {
        builds++;
        return empty;
      },
      async () => basis,
    );
    await Promise.all([cache.read("/acme"), cache.read("/acme")]);
    await cache.read("/acme");
    expect(builds).toBe(1);
    basis = "two";
    await cache.read("/acme");
    expect(builds).toBe(2);
  });

  test("does not hold a failed build", async () => {
    let builds = 0;
    const cache = createSpecGraphCache(
      async () => {
        builds++;
        if (builds === 1) throw new Error("unreadable");
        return empty;
      },
      async () => "one",
    );
    await expect(cache.read("/acme")).rejects.toThrow("unreadable");
    expect(await cache.read("/acme")).toBe(empty);
  });
});

describe("buildSpecGraph", () => {
  let companion: string | undefined;
  afterEach(async () => {
    if (companion) await fs.rm(companion, { recursive: true, force: true });
    companion = undefined;
  });

  async function write(relative: string, content = "") {
    const file = path.join(companion!, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  test("finds nested capabilities inside a known one and skips removed ones", async () => {
    companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-graph-"));
    await write("openspec/specs/acme/spec.md", spec("acme").content);
    await write("openspec/specs/acme/billing/spec.md", spec("acme/billing").content);
    await write("openspec/changes/archive/2026-01-01-one/specs/acme/spec.md", "x");
    await write("openspec/changes/archive/2026-01-01-one/specs/acme/billing/spec.md", "x");
    await write("openspec/changes/archive/2026-01-01-one/specs/acme-gone/spec.md", "x");

    const graph = await buildSpecGraph(companion);

    expect(edgesOf(graph, "co-change")).toEqual([
      ["spec:acme", "spec:acme/billing", "co-change", 1],
    ]);
  });

  test("does not count a parent capability's folder that holds only nested delta specs", async () => {
    companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-graph-"));
    await write("openspec/specs/acme/spec.md", spec("acme").content);
    await write("openspec/specs/acme/billing/spec.md", spec("acme/billing").content);
    await write("openspec/specs/acme-cart/spec.md", spec("acme-cart").content);
    await write("openspec/changes/archive/2026-01-01-one/specs/acme/billing/spec.md", "x");
    await write("openspec/changes/archive/2026-01-01-one/specs/acme-cart/spec.md", "x");

    const graph = await buildSpecGraph(companion);

    expect(edgesOf(graph, "co-change")).toEqual([
      ["spec:acme-cart", "spec:acme/billing", "co-change", 1],
    ]);
    const parent = graph.nodes.findIndex((node) => node.id === "spec:acme");
    expect(graph.history[parent]).toEqual([]);
  });

  test("fingerprints spec edits and new archives, not other files", async () => {
    companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-graph-"));
    await write("openspec/specs/acme/spec.md", "a");
    const first = await specGraphFingerprint(companion);
    await write("openspec/changes/acme-open/proposal.md", "p");
    expect(await specGraphFingerprint(companion)).toBe(first);
    await write("openspec/specs/acme/spec.md", "ab");
    const edited = await specGraphFingerprint(companion);
    expect(edited).not.toBe(first);
    await write("openspec/changes/archive/2026-01-01-one/tasks.md", "t");
    expect(await specGraphFingerprint(companion)).not.toBe(edited);
  });

  test("reads specs and archives without changing the companion", async () => {
    companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-graph-"));
    await write(
      "openspec/specs/acme-auth/spec.md",
      spec("acme-auth", "acme/web", ["a"], "`acme-session`").content,
    );
    await write(
      "openspec/specs/acme-session/spec.md",
      spec("acme-session", "acme/web", ["a"]).content,
    );
    await write("openspec/changes/archive/2026-01-01-one/proposal.md", "# p");
    await write("openspec/changes/archive/2026-01-01-one/specs/acme-auth/spec.md", "x");
    await write("openspec/changes/archive/2026-01-01-one/specs/acme-session/spec.md", "x");
    const before = await snapshot(companion);

    const graph = await buildSpecGraph(companion);

    expect(edgesOf(graph, "co-change")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "co-change", 1],
    ]);
    expect(edgesOf(graph, "mentions")).toEqual([
      ["spec:acme-auth", "spec:acme-session", "mentions", 1],
    ]);
    expect(graph.archives[0].artifacts).toEqual(["proposal.md"]);
    expect(await snapshot(companion)).toEqual(before);
  });
});

async function snapshot(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = (await fs.stat(file)).mtimeMs;
  }
  return out;
}
