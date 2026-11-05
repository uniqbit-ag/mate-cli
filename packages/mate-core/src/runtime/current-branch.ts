import { execFile } from "node:child_process";

/** The branch checked out at `dir`; null when detached or outside Git. */
export function currentBranch(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir }, (error, out) =>
      resolve(error ? null : out.trim() || null),
    );
  });
}
