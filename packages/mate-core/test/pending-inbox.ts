import fs from "node:fs";
import path from "node:path";

import { git } from "./git-checkouts";

export interface SeededChange {
  name: string;
  /** `submitted` by default. */
  state?: "active" | "submitted";
  /** Recorded for `acme/product`; none records a not-applicable delivery. */
  branch?: string;
  blocked?: boolean;
  /** Who commits the change to the pending branch; the test identity by default. */
  author?: { name: string; email: string };
}

function writeChange(root: string, change: SeededChange): void {
  const dir = path.join(root, "openspec", "changes", change.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "proposal.md"), `# ${change.name}\n`);
  const delivery = change.branch
    ? `  - repository: acme/product\n    branch: ${change.branch}\n`
    : "  - repository: acme/product\n    notApplicable: spec only\n";
  const blocked = change.blocked
    ? "blocked:\n  reason: acme conflict\n  paths: [openspec/specs/widget/spec.md]\n  since: 2026-11-12T10:00:00.000Z\n"
    : "";
  fs.writeFileSync(
    path.join(dir, "delivery.yaml"),
    `version: 1\nchange: ${change.name}\nstate: ${change.state ?? "submitted"}\n${blocked}deliveries:\n${delivery}`,
  );
}

/** One commit per change, by its author, as each submit pushes its own. */
function commitChanges(companion: string, changes: readonly SeededChange[]): void {
  for (const change of changes) {
    writeChange(companion, change);
    const identity = change.author
      ? ["-c", `user.name=${change.author.name}`, "-c", `user.email=${change.author.email}`]
      : [];
    git(companion, "add", "-A");
    git(companion, ...identity, "commit", "-q", "-m", `submit ${change.name}`);
  }
}

/**
 * Makes `companion` a Git repository whose fetched inbox `refs/remotes/origin/mate/inbox` holds
 * `changes`, as a sync leaves it; the checkout holds none of them. `archived` names change
 * folders the fetched default branch holds archived. No inbox ref when `changes` is null.
 */
export function seedPending(
  companion: string,
  changes: SeededChange[] | null,
  archived: string[] = [],
): string {
  git(path.dirname(companion), "init", "-q", companion);
  git(companion, "commit", "-q", "--allow-empty", "-m", "seed");
  const seed = git(companion, "rev-parse", "HEAD").trim();
  const branch = git(companion, "symbolic-ref", "--short", "HEAD").trim();
  git(companion, "remote", "add", "origin", "https://example.invalid/acme/companion.git");
  git(companion, "config", `branch.${branch}.remote`, "origin");
  git(companion, "config", `branch.${branch}.merge`, "refs/heads/main");
  for (const name of archived) {
    const dir = path.join(companion, "openspec", "changes", "archive", `2026-11-01-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "proposal.md"), `# ${name}\n`);
  }
  git(companion, "add", "-A");
  git(companion, "commit", "-q", "--allow-empty", "-m", "default");
  git(companion, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (changes !== null) {
    commitChanges(companion, changes);
    git(companion, "update-ref", "refs/remotes/origin/mate/inbox", "HEAD");
  }
  git(companion, "reset", "-q", "--hard", seed);
  return companion;
}
