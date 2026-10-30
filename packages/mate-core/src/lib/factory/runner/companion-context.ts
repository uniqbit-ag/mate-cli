import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { resolveSecretPolicy } from "../../../runtime/policy";
import { mateSessionEnvironment } from "../../orchestrator/adapters/base";
import { readCompanionConfig } from "../../orchestrator/config-store";

/**
 * What an interactive Workset session gets from `mate claude`, for AFK turns: the
 * companion's skills, its policy and its agent instructions. The harness writes each skill to the
 * container's `~/.claude/skills`, where Claude Code lists only names and descriptions
 * until one is invoked.
 */

export interface CompanionSkill {
  name: string;
  description: string;
  content: string;
  files: { path: string; content: string }[];
}

/** Larger files and anything that is not UTF-8 text stay out of a skill. */
const MAX_FILE_BYTES = 256 * 1024;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)*/;

function frontmatter(text: string): Record<string, unknown> {
  const match = FRONTMATTER.exec(text);
  if (!match) return {};
  try {
    const parsed = parse(match[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function textFile(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

/** Every file under the skill directory but `SKILL.md`, as skill-relative POSIX paths. */
async function skillFiles(dir: string): Promise<{ path: string; content: string }[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(dir, absolute).split(path.sep).join("/");
        if (relative === "SKILL.md") return null;
        const content = await textFile(absolute);
        return content === null ? null : { path: relative, content };
      }),
  );
  return files
    .filter((file): file is { path: string; content: string } => file !== null)
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

/** The companion's `.claude/skills`, sorted by name; a skill without a description is skipped. */
export async function companionSkills(companionPath: string): Promise<CompanionSkill[]> {
  const root = path.join(companionPath, ".claude", "skills");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
      .map(async (entry): Promise<CompanionSkill | null> => {
        const dir = path.join(root, entry.name);
        const content = await textFile(path.join(dir, "SKILL.md"));
        if (content === null) return null;
        const meta = frontmatter(content);
        const description =
          typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
        if (!description) return null;
        // The harness writes its own `name`/`description` frontmatter above `content` and
        // inserts the description unquoted, so it gets a quoted YAML scalar and the body only.
        return {
          name: entry.name,
          description: JSON.stringify(description),
          content: content.replace(FRONTMATTER, ""),
          files: await skillFiles(dir),
        };
      }),
  );
  return skills
    .filter((skill): skill is CompanionSkill => skill !== null)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The Workset image's PATH, with the wrapper bin first as a launch puts it. */
const WORKSET_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * What `mate claude` gives a session in the Workset's worktree: the companion policy
 * (artifact location, the wrapper-only CLIs, secret handling) followed by the
 * companion's `AGENTS.md`, and the Mate variables the wrappers read.
 */
export async function companionSession(
  companionPath: string,
  repository: { id: string; path: string },
): Promise<{ instructions: string; env: Record<string, string> }> {
  const config = await readCompanionConfig(companionPath);
  const capabilities = config.capabilities ?? [];
  const policy = buildCompanionGuidance({
    companionPath,
    repository,
    capabilities,
    secretGuardrails: resolveSecretPolicy(companionPath).guardrails,
  });
  const agents = await textFile(path.join(companionPath, "AGENTS.md"));
  const env = mateSessionEnvironment({
    repository,
    companionPath,
    capabilities,
    git: config.git,
    allowedAgents: config.allowedAgents,
  });
  const wrappers = env.MATE_WRAPPER_BIN_PATH;
  return {
    instructions: [policy, agents?.trim()].filter(Boolean).join("\n\n"),
    env: { ...env, PATH: wrappers ? `${wrappers}:${WORKSET_PATH}` : WORKSET_PATH },
  };
}
