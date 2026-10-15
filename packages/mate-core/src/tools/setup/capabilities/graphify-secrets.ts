import fs from "node:fs/promises";
import path from "node:path";

import { isSecretFile, type SecretPolicy } from "../../../runtime/secret-patterns";
import { scanContent, scanFiles } from "../../../runtime/secret-scan";
import { resolveGitInfoExcludePath } from "../git-utils";

export const GRAPHIFY_IGNORE_FILE = ".graphifyignore";
const REGION_BEGIN = "# mate:secrets begin (managed by Mate; edits are overwritten)";
const REGION_END = "# mate:secrets end";

export class GraphifySecretExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphifySecretExclusionError";
  }
}

function renderRegion(policy: SecretPolicy): string[] {
  return [
    REGION_BEGIN,
    ...policy.deny,
    ...policy.allow.map((pattern) => `!${pattern}`),
    REGION_END,
  ];
}

/** Content with every Mate region removed, so a hand-copied duplicate goes too. */
function stripRegions(content: string): string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("# mate:secrets begin")) inside = true;
    else if (inside && line === REGION_END) inside = false;
    else if (!inside) kept.push(line);
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  return kept;
}

/** The region is intact when the file ends with exactly the lines Mate renders. */
function endsWithRegion(content: string, region: string[]): boolean {
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-region.length);
  return tail.length === region.length && tail.every((line, index) => line === region[index]);
}

async function excludeFromGit(repoPath: string): Promise<void> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return;
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    // Fresh repos may not have created info/exclude yet.
  }
  const entry = `/${GRAPHIFY_IGNORE_FILE}`;
  if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(excludePath, `${existing}${separator}${entry}\n`, "utf8");
}

/**
 * Keeps Mate's secret region as the last block of `.graphifyignore`, which
 * graphify reads last-match-wins, so no earlier user line can re-include a
 * secret file. Rewritten before every Mate-run extraction, not only at setup.
 * Throws when the region can't be written or read back; callers warn and run
 * anyway, since the `--exclude` arguments and the output pruning still apply.
 * With guardrails off it only removes Mate's region.
 */
export async function ensureGraphifySecretExclusion(
  repoPath: string,
  policy: SecretPolicy,
): Promise<void> {
  const filePath = path.join(repoPath, GRAPHIFY_IGNORE_FILE);
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GraphifySecretExclusionError(
        `the secret exclusion in ${filePath} could not be read: ${(error as Error).message}`,
      );
    }
  }

  const kept = stripRegions(existing ?? "");
  if (!policy.guardrails) {
    if (existing === undefined) return;
    if (kept.every((line) => line.trim() === "")) await fs.rm(filePath, { force: true });
    else await fs.writeFile(filePath, `${kept.join("\n")}\n`, "utf8");
    return;
  }

  const region = renderRegion(policy);
  const next = `${[...kept, ...(kept.length > 0 ? [""] : []), ...region].join("\n")}\n`;
  try {
    if (next !== existing) await fs.writeFile(filePath, next, "utf8");
    if (!endsWithRegion(await fs.readFile(filePath, "utf8"), region)) {
      throw new Error("the file does not end with Mate's region after writing it");
    }
  } catch (error) {
    throw new GraphifySecretExclusionError(
      `the secret exclusion in ${filePath} could not be enforced: ${(error as Error).message}`,
    );
  }
  if (existing === undefined) await excludeFromGit(repoPath);
}

/**
 * `--exclude` arguments for the secret patterns. graphify applies them over
 * every ignore file, a user's `!` negation included. Only `extract` and the
 * `<path> --update` form accept them; the `update` subcommand rejects the flag.
 */
export function graphifySecretExcludeArgs(policy: SecretPolicy): string[] {
  return policy.guardrails ? policy.deny.flatMap((pattern) => ["--exclude", pattern]) : [];
}

const GRAPH_SECTIONS = ["nodes", "links", "hyperedges"] as const;

type GraphSection = (typeof GRAPH_SECTIONS)[number];

type GraphEntry = Record<string, unknown>;

function entriesOf(graph: Record<string, unknown>, section: string): GraphEntry[] {
  const entries = graph[section];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is GraphEntry => !!entry && typeof entry === "object")
    : [];
}

/** Every node id an entry points at: link endpoints and hyperedge members. */
function referencedIds(entry: GraphEntry): string[] {
  const ids = [entry.source, entry.target, ...(Array.isArray(entry.nodes) ? entry.nodes : [])];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Takes the secrets out of graph.json and keeps the rest: entries whose source
 * is a secret file, entries whose content secretlint flags (one entry per line,
 * so a finding's line names its entry), and links or hyperedges left pointing
 * at a removed node. Returns notes naming paths and rule ids, never values.
 */
async function pruneGraph(graphPath: string, policy: SecretPolicy): Promise<string[]> {
  let graph: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(graphPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    graph = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const notes: string[] = [];
  const dropped: Record<GraphSection, Set<number>> = {
    nodes: new Set(),
    links: new Set(),
    hyperedges: new Set(),
  };
  const secretSources = new Set<string>();
  const lines: { section: GraphSection; index: number }[] = [];
  const text: string[] = [];
  for (const section of GRAPH_SECTIONS) {
    entriesOf(graph, section).forEach((entry, index) => {
      const source = typeof entry.source_file === "string" ? entry.source_file : "";
      if (source && isSecretFile(source, policy)) {
        secretSources.add(source);
        dropped[section].add(index);
        return;
      }
      lines.push({ section, index });
      text.push(JSON.stringify(entry));
    });
  }
  for (const source of secretSources) notes.push(`left out secret file ${source}`);

  const findings = text.length > 0 ? await scanContent(graphPath, text.join("\n")) : [];
  const rules = new Set<string>();
  for (const finding of findings) {
    const line = lines[finding.line - 1];
    if (!line) continue;
    dropped[line.section].add(line.index);
    rules.add(finding.ruleId);
  }
  const valueEntries = new Set(findings.map((finding) => finding.line)).size;
  if (valueEntries > 0) {
    notes.push(
      `left out ${valueEntries} graph ${valueEntries === 1 ? "entry" : "entries"} containing a secret (${[...rules].join(", ")})`,
    );
  }
  if (Object.values(dropped).every((indexes) => indexes.size === 0)) return notes;

  const nodes = entriesOf(graph, "nodes");
  const removedIds = new Set(
    nodes
      .filter((_, index) => dropped.nodes.has(index))
      .map((node) => node.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const next: Record<string, unknown> = { ...graph };
  for (const section of GRAPH_SECTIONS) {
    if (!Array.isArray(graph[section])) continue;
    next[section] = entriesOf(graph, section).filter(
      (entry, index) =>
        !dropped[section].has(index) && !referencedIds(entry).some((id) => removedIds.has(id)),
    );
  }
  await fs.writeFile(graphPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return notes;
}

/**
 * Checks graphify's output instead of trusting its ignore handling, and never
 * stops the run: secrets are taken out and everything else is kept. graph.json
 * is pruned entry by entry; any other output file holding a secret (a report,
 * a cache entry, the HTML view) is removed, since graphify regenerates it.
 * Returns notes for the operator; a check that can't run becomes a note too.
 */
export async function pruneGraphifySecrets(
  graphifyOut: string,
  policy: SecretPolicy,
): Promise<string[]> {
  if (!policy.guardrails) return [];
  const graphPath = path.join(graphifyOut, "graph.json");
  const notes: string[] = [];
  try {
    notes.push(...(await pruneGraph(graphPath, policy)));
  } catch (error) {
    notes.push(`graph.json could not be checked for secrets: ${(error as Error).message}`);
  }

  try {
    const entries = await fs.readdir(graphifyOut).catch((): string[] => []);
    const others = entries
      .filter((entry) => entry !== "graph.json")
      .map((entry) => path.join(graphifyOut, entry));
    const findings = await scanFiles(others);
    const byFile = new Map<string, Set<string>>();
    for (const finding of findings) {
      byFile.set(finding.path, (byFile.get(finding.path) ?? new Set()).add(finding.ruleId));
    }
    for (const [file, rules] of byFile) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of files at most
      await fs.rm(file, { force: true });
      notes.push(
        `removed ${path.relative(graphifyOut, file)}, which held a secret (${[...rules].join(", ")})`,
      );
    }
  } catch (error) {
    notes.push(`the graphify output could not be checked for secrets: ${(error as Error).message}`);
  }
  return notes;
}
