import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { resolveSecretPolicy } from "../../../runtime/policy";
import { deployReactDoctorSkill } from "../../../tools/setup/capabilities/react-doctor";
import { applyMateSkills } from "../../../tools/setup/mate";
import { mateSessionEnvironment } from "../../orchestrator/adapters/base";
import { readCompanionConfig } from "../../orchestrator/config-store";
import type { FrameworkConfig } from "../../orchestrator/types";

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

/** The Mate skills each capability deploys into `.claude/skills`, as its sync would. */
const MATE_SKILL_DEPLOYERS = [
  { capability: "openspec", deploy: (skillsDir: string) => applyMateSkills(skillsDir, "claude") },
  { capability: "react-doctor", deploy: deployReactDoctorSkill },
] as const;

async function readSkill(dir: string, name: string): Promise<CompanionSkill | null> {
  const content = await textFile(path.join(dir, "SKILL.md"));
  if (content === null) return null;
  const meta = frontmatter(content);
  const description =
    typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
  if (!description) return null;
  // The harness writes its own `name`/`description` frontmatter above `content` and
  // inserts the description unquoted, so it gets a quoted YAML scalar and the body only.
  return {
    name,
    description: JSON.stringify(description),
    content: content.replace(FRONTMATTER, ""),
    files: await skillFiles(dir),
  };
}

async function readSkills(root: string): Promise<CompanionSkill[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
      .map((entry) => readSkill(path.join(root, entry.name), entry.name)),
  );
  return skills.filter((skill): skill is CompanionSkill => skill !== null);
}

/**
 * The installed Mate's skills for the enabled capabilities. Deployed to a temporary
 * directory: the companion's copies are not committed, so they may be missing or
 * from an older Mate, and the companion is never written.
 */
async function installedMateSkills(config: FrameworkConfig): Promise<CompanionSkill[]> {
  if (!config.allowedAgents?.includes("claude")) return [];
  const enabled = new Set((config.capabilities ?? []).map((capability) => capability.name));
  const deployers = MATE_SKILL_DEPLOYERS.filter((deployer) => enabled.has(deployer.capability));
  if (deployers.length === 0) return [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-factory-skills-"));
  try {
    for (const deployer of deployers) {
      // oxlint-disable-next-line no-await-in-loop -- deployers write into the same directory
      await deployer.deploy(dir);
    }
    return await readSkills(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The companion's `.claude/skills` with the installed Mate's skills over same-named
 * copies, sorted by name; a skill without a description is skipped.
 */
export async function companionSkills(
  companionPath: string,
  config?: FrameworkConfig,
): Promise<CompanionSkill[]> {
  const [own, mate] = await Promise.all([
    readSkills(path.join(companionPath, ".claude", "skills")),
    installedMateSkills(config ?? (await readCompanionConfig(companionPath))),
  ]);
  const byName = new Map([...own, ...mate].map((skill) => [skill.name, skill]));
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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
  config?: FrameworkConfig,
): Promise<{ instructions: string; env: Record<string, string> }> {
  config ??= await readCompanionConfig(companionPath);
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
