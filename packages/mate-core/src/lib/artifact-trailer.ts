import { parseAnchor } from "./change-layout";

// Revert lookup, resume and sync reconciliation read the artifact trailer too.
export { ARTIFACT_TRAILER, INBOX_TRAILER } from "../runtime/artifact-trailers";

/** Commit trailer with a unique id per commit attempt; settles whether a cut-off push landed. */
export const TRANSACTION_TRAILER = "Mate-Transaction";

const OPENSPEC_PREFIX = "openspec/";

/** The trailer value of an archived OpenSpec change. */
export function openspecArtifact(anchor: string): string {
  return `${OPENSPEC_PREFIX}${anchor}`;
}

/** The trailer value of a spec publication, named after its date and specs. */
export function openspecSpecsArtifact(anchor: string): string {
  return `${OPENSPEC_PREFIX}specs/${anchor}`;
}

/** The archive anchor an artifact trailer value names; null for any other artifact. */
export function archiveOfArtifact(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(OPENSPEC_PREFIX)) return null;
  const anchor = trimmed.slice(OPENSPEC_PREFIX.length);
  return parseAnchor(anchor) ? anchor : null;
}
