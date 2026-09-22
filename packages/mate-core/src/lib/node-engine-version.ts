/**
 * The Node.js version an `engines.node` range may be enforced against, or null
 * where there is none to enforce.
 *
 * Under Bun, `process.versions.node` is a compatibility claim rather than an
 * installed Node release: it trails upstream on Bun's own schedule, and Bun
 * ignores `engines` when loading a package anyway. Comparing a real range such
 * as `^24.15.0` against that claim refuses graphs the runtime loads perfectly
 * well, so there is nothing meaningful to compare and the check is skipped.
 */
export function enforceableNodeVersion(
  versions: NodeJS.ProcessVersions = process.versions,
): string | null {
  return versions.bun === undefined ? versions.node : null;
}
