import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { defaultSecretPolicy, parseSecretsConfig } from "../../../runtime/secret-patterns";
import {
  ensureGraphifySecretExclusion,
  GRAPHIFY_IGNORE_FILE,
  graphifySecretExcludeArgs,
  GraphifySecretExclusionError,
  pruneGraphifySecrets,
} from "./graphify-secrets";

/** Assembled at runtime so no key-shaped literal sits in the repository. */
const KEY_MARKER = ["RSA PRIVATE", "KEY"].join(" ");
const PRIVATE_KEY = [
  `-----BEGIN ${KEY_MARKER}-----`,
  "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
  "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
  "o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k",
  "TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7",
  "9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy",
  "v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs",
  "/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00",
  `-----END ${KEY_MARKER}-----`,
].join("\n");

const tempRoots: string[] = [];

async function makeRepo(ignore?: string): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "graphify-secrets-"));
  tempRoots.push(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  if (ignore !== undefined) await fs.writeFile(path.join(repo, GRAPHIFY_IGNORE_FILE), ignore);
  return repo;
}

async function readIgnore(repo: string): Promise<string> {
  return fs.readFile(path.join(repo, GRAPHIFY_IGNORE_FILE), "utf8");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ensureGraphifySecretExclusion", () => {
  test("creates the region and hides the file from git", async () => {
    const repo = await makeRepo();

    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());

    const content = await readIgnore(repo);
    expect(content).toContain("# mate:secrets begin");
    expect(content).toContain("\n.env\n");
    expect(content).toContain("\n!.env.example\n");
    const exclude = await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.graphifyignore");
  });

  test("keeps the region last, below a user negation added after it", async () => {
    const repo = await makeRepo("dist/\n");
    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());
    await fs.appendFile(path.join(repo, GRAPHIFY_IGNORE_FILE), "!.env\n");

    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());

    const lines = (await readIgnore(repo)).trimEnd().split("\n");
    expect(lines[0]).toBe("dist/");
    expect(lines.indexOf("!.env")).toBeLessThan(lines.indexOf(".env"));
    expect(lines.at(-1)).toBe("# mate:secrets end");
  });

  test("rewrites a region deleted by hand, and is idempotent", async () => {
    const repo = await makeRepo();
    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());
    const first = await readIgnore(repo);
    await fs.writeFile(path.join(repo, GRAPHIFY_IGNORE_FILE), "");

    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());
    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());

    expect(await readIgnore(repo)).toBe(first);
  });

  test("an unwritable file refuses with a secret-exclusion error", async () => {
    const repo = await makeRepo("dist/\n");
    await fs.chmod(path.join(repo, GRAPHIFY_IGNORE_FILE), 0o444);
    try {
      await expect(ensureGraphifySecretExclusion(repo, defaultSecretPolicy())).rejects.toThrow(
        GraphifySecretExclusionError,
      );
    } finally {
      await fs.chmod(path.join(repo, GRAPHIFY_IGNORE_FILE), 0o644);
    }
  });

  test("an opt-out removes only Mate's region", async () => {
    const repo = await makeRepo("dist/\n");
    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());

    await ensureGraphifySecretExclusion(repo, parseSecretsConfig({ guardrails: false }));

    expect(await readIgnore(repo)).toBe("dist/\n");
  });

  test("an opt-out deletes a file that only held Mate's region", async () => {
    const repo = await makeRepo();
    await ensureGraphifySecretExclusion(repo, defaultSecretPolicy());

    await ensureGraphifySecretExclusion(repo, parseSecretsConfig({ guardrails: false }));

    await expect(fs.access(path.join(repo, GRAPHIFY_IGNORE_FILE))).rejects.toThrow();
  });
});

describe("graphifySecretExcludeArgs", () => {
  test("passes every deny pattern as --exclude while guardrails are on", () => {
    const args = graphifySecretExcludeArgs(parseSecretsConfig({ deny: ["*.secret"] }));
    expect(args.slice(0, 4)).toEqual(["--exclude", ".env", "--exclude", ".env.*"]);
    expect(args.slice(-2)).toEqual(["--exclude", "*.secret"]);
  });

  test("passes nothing after an opt-out", () => {
    expect(graphifySecretExcludeArgs(parseSecretsConfig({ guardrails: false }))).toEqual([]);
  });
});

describe("pruneGraphifySecrets", () => {
  const TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

  async function output(graph: unknown, extra: Record<string, string> = {}): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "graphify-out-"));
    tempRoots.push(root);
    const out = path.join(root, "graphify-out");
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, "graph.json"), JSON.stringify(graph, null, 2));
    for (const [name, content] of Object.entries(extra)) {
      await fs.writeFile(path.join(out, name), content);
    }
    return out;
  }

  async function readGraph(out: string) {
    return JSON.parse(await fs.readFile(path.join(out, "graph.json"), "utf8"));
  }

  const graph = () => ({
    directed: false,
    nodes: [
      { id: "app", source_file: "src/app.ts" },
      { id: "leak", source_file: "acme/.env.local" },
      { id: "app_main", source_file: "src/app.ts" },
    ],
    links: [
      { source: "app", target: "app_main", source_file: "src/app.ts" },
      { source: "app", target: "leak", source_file: "src/app.ts" },
    ],
    hyperedges: [],
  });

  test("leaves out a secret file's nodes and the links pointing at them, keeping the rest", async () => {
    const out = await output(graph());

    const notes = await pruneGraphifySecrets(out, defaultSecretPolicy());

    const pruned = await readGraph(out);
    expect(pruned.nodes.map((node: { id: string }) => node.id)).toEqual(["app", "app_main"]);
    expect(pruned.links).toEqual([
      { source: "app", target: "app_main", source_file: "src/app.ts" },
    ]);
    expect(pruned.directed).toBe(false);
    expect(notes).toEqual(["left out secret file acme/.env.local"]);
  });

  test("leaves out an entry holding a secret value, naming the rule but not the value", async () => {
    const tainted = graph();
    tainted.nodes[2] = {
      id: "app_main",
      source_file: "src/app.ts",
      label: `token ${TOKEN}`,
    } as never;
    const out = await output(tainted);

    const notes = await pruneGraphifySecrets(out, defaultSecretPolicy());

    const pruned = await readGraph(out);
    expect(pruned.nodes.map((node: { id: string }) => node.id)).toEqual(["app"]);
    expect(pruned.links).toEqual([]);
    expect(notes.join("\n")).toContain("@secretlint/secretlint-rule-github");
    expect(notes.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(pruned)).not.toContain(TOKEN);
  });

  test("removes another output file that holds a secret and keeps the graph", async () => {
    const out = await output(
      { nodes: [{ id: "app", source_file: "src/app.ts" }], links: [] },
      { "GRAPH_REPORT.md": `key:\n${PRIVATE_KEY}\n`, "graph.html": "<p>fine</p>" },
    );

    const notes = await pruneGraphifySecrets(out, defaultSecretPolicy());

    await expect(fs.access(path.join(out, "GRAPH_REPORT.md"))).rejects.toThrow();
    await fs.access(path.join(out, "graph.html"));
    expect((await readGraph(out)).nodes).toHaveLength(1);
    expect(notes.join("\n")).toContain("removed GRAPH_REPORT.md");
    expect(notes.join("\n")).not.toContain("MIIBOgIBAAJBAK");
  });

  test("leaves clean output untouched and reports nothing", async () => {
    const clean = { nodes: [{ id: "a", source_file: "src/app.ts" }], links: [] };
    const out = await output(clean);
    const before = await fs.readFile(path.join(out, "graph.json"), "utf8");

    expect(await pruneGraphifySecrets(out, defaultSecretPolicy())).toEqual([]);
    expect(await fs.readFile(path.join(out, "graph.json"), "utf8")).toBe(before);
  });

  test("never throws, even without any output", async () => {
    expect(await pruneGraphifySecrets("/nonexistent/graphify-out", defaultSecretPolicy())).toEqual(
      [],
    );
  });

  test("does nothing after an opt-out", async () => {
    const out = await output(graph());
    expect(await pruneGraphifySecrets(out, parseSecretsConfig({ guardrails: false }))).toEqual([]);
    expect((await readGraph(out)).nodes).toHaveLength(3);
  });
});
