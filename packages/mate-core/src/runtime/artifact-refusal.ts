/** The artifact-write refusal both runtimes print; pure, so either guard can import it. */
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";

/** Matched by consumers and tests; keep byte-identical. */
export const ARTIFACT_REFUSAL_HEADLINE = "artifact writes must go to the companion framework path.";

export interface ArtifactRefusalInput {
  /** As the tool supplied it, relative or absolute. */
  target: string;
  /** The absolute path the guard judged. */
  resolved: string;
  companion: string;
  /** The Working Repository root relative targets resolve against. */
  repoRoot: string;
}

/** The absolute path both guards judge: a relative target resolves against the repo root, never a `cd`. */
export function resolveArtifactTarget(target: string, repoRoot: string): string {
  if (path.isAbsolute(target)) return path.normalize(target);
  return path.normalize(path.join(repoRoot, target));
}

function relativeInside(target: string, root: string): string | null {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

/** The refusal text, without a trailing newline. */
export function artifactRefusal({
  target,
  resolved,
  companion,
  repoRoot,
}: ArtifactRefusalInput): string {
  const isRelative = !path.isAbsolute(target);
  const inside = relativeInside(resolved, repoRoot);
  const suggested = inside ? path.join(companion, inside) : null;

  const lines = [
    `${FRAMEWORK_NAME} guardrail: ${ARTIFACT_REFUSAL_HEADLINE}`,
    ` target:    ${target}`,
  ];
  if (isRelative) lines.push(` resolved:  ${resolved}`);
  lines.push(` companion: ${companion}`);
  if (suggested) lines.push(` suggested: ${suggested}`);
  if (isRelative) {
    lines.push(
      "Relative paths resolve against the working repository; a preceding `cd` is not followed.",
    );
  }
  lines.push(
    suggested
      ? "Rewrite to the suggested absolute path and retry."
      : `Use an absolute path under ${companion}.`,
  );
  if (path.basename(target) === "CLAUDE.md") {
    lines.push(`Note: CLAUDE.md already lives in the companion repo at ${companion}/CLAUDE.md.`);
  }
  return lines.join("\n");
}
