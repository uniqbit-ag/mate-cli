import fs from "node:fs/promises";
import path from "node:path";

import { layerGuidanceText } from "./audience-layer";
import { OPENCODE_MCP_SERVERS_AT } from "./runtime-document-manifest";

/**
 * Reads an audience layer the OpenCode Runtime Surface wrote, as what the Mate
 * OpenCode plugin applies through the plugin API. The surface re-exports it as
 * its own reader; it lives under `runtime/` only so the import-isolated plugin
 * can reach it. The plugin parses no OpenCode document itself.
 */

export interface LayerMcpServer {
  name: string;
  /** The entry exactly as the surface wrote it under `mcp.servers`. */
  config: Record<string, unknown>;
}

export interface LayerSkill {
  id: string;
  name: string;
  description?: string;
  /** The skill's `SKILL.md`. */
  path: string;
  content: string;
}

export type LayerAgentMode = "subagent" | "primary" | "all";

export interface LayerAgent {
  id: string;
  description?: string;
  mode: LayerAgentMode;
  /** The agent's prompt: the definition's body. */
  system: string;
}

export interface OpenCodeLayerContents {
  mcpServers: LayerMcpServer[];
  skills: LayerSkill[];
  agents: LayerAgent[];
  /** The layer's guidance sections, managed-block markers removed. */
  guidance: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitFrontmatter(content: string): { fields: string; body: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match
    ? { fields: match[1]!, body: content.slice(match[0].length) }
    : { fields: "", body: content };
}

function frontmatterScalarFromFields(fields: string, key: string): string | undefined {
  const value = fields.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return value?.replace(
    /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
    (_all, doubleQuoted?: string, singleQuoted?: string) => doubleQuoted ?? singleQuoted ?? "",
  );
}

/** One scalar of a simple YAML frontmatter, quotes removed. */
export function frontmatterScalar(content: string, key: string): string | undefined {
  return frontmatterScalarFromFields(splitFrontmatter(content).fields, key);
}

/** An id OpenCode accepts for a skill or agent name. */
export function contributionId(name: string, fallback: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

async function findSkillFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isFile() && entry.name === "SKILL.md") return Promise.resolve([entryPath]);
        return entry.isDirectory() ? findSkillFiles(entryPath) : Promise.resolve([]);
      }),
    );
    return nested.flat().toSorted();
  } catch {
    return [];
  }
}

/** Every `SKILL.md` under `roots`; an unreadable skill is skipped, never fatal. */
export async function loadSkillInfos(roots: readonly string[]): Promise<LayerSkill[]> {
  const files = (await Promise.all(roots.map(findSkillFiles))).flat();
  const skills = await Promise.all(
    files.map(async (filePath): Promise<LayerSkill | null> => {
      try {
        const content = await fs.readFile(filePath, "utf8");
        const { fields } = splitFrontmatter(content);
        const name =
          frontmatterScalarFromFields(fields, "name") || path.basename(path.dirname(filePath));
        const description = frontmatterScalarFromFields(fields, "description");
        return {
          id: contributionId(name, "mate-skill"),
          name,
          ...(description ? { description } : {}),
          path: filePath,
          content,
        };
      } catch {
        return null;
      }
    }),
  );
  return skills.filter((skill) => skill !== null);
}

async function readMcpServers(root: string): Promise<LayerMcpServer[]> {
  const parsed = await fs
    .readFile(path.join(root, ".opencode", "opencode.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  let servers: unknown = parsed;
  for (const key of OPENCODE_MCP_SERVERS_AT) servers = isRecord(servers) ? servers[key] : undefined;
  if (!isRecord(servers)) return [];
  return Object.entries(servers)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, config]) => ({ name, config }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function agentMode(value: string | undefined): LayerAgentMode {
  return value === "subagent" || value === "primary" ? value : "all";
}

async function readAgents(root: string): Promise<LayerAgent[]> {
  const dir = path.join(root, ".opencode", "agents");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const agents = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .toSorted()
      .map(async (name): Promise<LayerAgent | null> => {
        const content = await fs.readFile(path.join(dir, name), "utf8").catch(() => null);
        if (content === null) return null;
        const { fields, body } = splitFrontmatter(content);
        const description = frontmatterScalarFromFields(fields, "description");
        return {
          id: contributionId(path.basename(name, ".md"), "mate-agent"),
          ...(description ? { description } : {}),
          mode: agentMode(frontmatterScalarFromFields(fields, "mode")),
          system: body.trim(),
        };
      }),
  );
  return agents.filter((agent) => agent !== null);
}

async function readGuidance(root: string): Promise<string> {
  return layerGuidanceText(await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => ""));
}

export async function readOpenCodeAudienceLayer(root: string): Promise<OpenCodeLayerContents> {
  const [mcpServers, skills, agents, guidance] = await Promise.all([
    readMcpServers(root),
    loadSkillInfos([path.join(root, ".agents", "skills")]),
    readAgents(root),
    readGuidance(root),
  ]);
  return { mcpServers, skills, agents, guidance };
}
