import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ArtifactType } from "../packages/mate-core/src/lib/delivery/staging/artifact-type";
import { createTempDir } from "./fixtures";

/**
 * Sanitized local Git fixtures for Work sharing tests: one bare "remote" and independent
 * clones standing for teammates. No network; each clone has its own Git identity.
 */

export interface GitTeam {
  root: string;
  remote: string;
  clone(name: string, identity?: { name: string; email: string }): string;
  cleanup(): void;
}

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
  delete (ENV as Record<string, string | undefined>)[key];
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

export function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A complete mate-v1 change scoped to `acme/web`. */
export function writeChange(
  root: string,
  name: string,
  options: { dependsOn?: string[] } = {},
): void {
  const dir = `openspec/changes/${name}`;
  const depends = options.dependsOn ? `dependsOn: [${options.dependsOn.join(", ")}]\n` : "";
  write(root, `${dir}/.openspec.yaml`, "schema: mate-v1\n");
  write(
    root,
    `${dir}/proposal.md`,
    `---\nscopes:\n  - repository: acme/web\n    area: .\n${depends}---\n\n## Why\n\n${name}\n`,
  );
  write(root, `${dir}/design.md`, "# Design\n");
  write(root, `${dir}/tasks.md`, "- [ ] 1.1 Do it\n");
  write(root, `${dir}/specs/acme/spec.md`, "## ADDED Requirements\n");
  write(root, `${dir}/delivery.yaml`, `version: 1\nchange: ${name}\ndeliveries: []\n`);
}

/** A second artifact type: one `note.md` per change below `notes/`. Never published here. */
export const NOTES_TYPE: ArtifactType = {
  name: "acme-notes",
  source: "notes",
  archiveRoot: "notes-archive",
  deliveryFile: "delivery.yaml",
  isRecordId: (id) => /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id),
  recordName: (id) => id.slice(11),
  check: async (dir, name) =>
    fs.existsSync(path.join(dir, "notes", name, "note.md")) ? null : "no note.md",
  apply: async () => ({ ok: false, failure: "not published in Work tests" }) as never,
};

/** A note change of {@link NOTES_TYPE}. */
export function writeNote(root: string, name: string): void {
  write(root, `notes/${name}/note.md`, `${name}\n`);
  write(root, `notes/${name}/delivery.yaml`, `version: 1\nchange: ${name}\ndeliveries: []\n`);
}

export function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

export async function gitTeam(): Promise<GitTeam> {
  const root = await createTempDir("acme-work-git-");
  const remote = path.join(root, "acme-remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.name", "Acme Seed");
  git(seed, "config", "user.email", "seed@acme.test");
  write(seed, "README.md", "acme companion\n");
  commitAll(seed, "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  return {
    root,
    remote,
    clone(name, identity = { name: `Acme ${name}`, email: `${name}@acme.test` }) {
      const target = path.join(root, name);
      git(root, "clone", "-q", remote, target);
      git(target, "config", "user.name", identity.name);
      git(target, "config", "user.email", identity.email);
      return target;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
