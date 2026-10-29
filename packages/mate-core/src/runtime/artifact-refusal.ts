/** The artifact-write refusal both runtimes print; pure, so either guard can import it. */
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { isWithin } from "./physical-path";

/** Matched by consumers and tests; keep byte-identical. */
export const ARTIFACT_REFUSAL_HEADLINE = "artifact writes must go to the companion framework path.";

export interface ArtifactRefusalInput {
  /** As the tool supplied it, relative or absolute. */
  target: string;
  /** The absolute path the guard judged. */
  resolved: string;
  companion: string;
  /** The Working Repository root relative targets resolve against; empty without one. */
  repoRoot: string;
}

/** The absolute path both guards judge: a relative target resolves against `base`, never a `cd`. */
export function resolveArtifactTarget(target: string, base: string): string {
  if (path.isAbsolute(target)) return path.normalize(target);
  return path.normalize(path.join(base, target));
}

function relativeInside(target: string, root: string): string | null {
  if (!root || !isWithin(target, root)) return null;
  return path.relative(path.normalize(root), path.normalize(target)) || null;
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
      repoRoot
        ? "Relative paths resolve against the working repository; a preceding `cd` is not followed."
        : "Relative paths resolve against the session's folder; a preceding `cd` is not followed.",
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
