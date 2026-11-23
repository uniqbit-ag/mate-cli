/**
 * Reads the publication trailers of a type that keeps no archive. Lives under `runtime/`
 * because the session-start sync needs it and may not import `lib/`.
 */
import { outputLines, type CompanionGit } from "./companion-git";

/**
 * Commit trailer naming the artifact a commit stages or publishes, as `<type>/<id>`, so one
 * key serves every artifact type.
 */
export const ARTIFACT_TRAILER = "Mate-Artifact";

/**
 * Commit trailer naming the inbox commit a publication read its changes from, on types without
 * an archive: a later submission of the same name is no ancestor of it, whatever the clocks say.
 */
export const INBOX_TRAILER = "Mate-Inbox";

/** A record published at a ref, with the inbox commit it was published from when recorded. */
export interface TrailerRecord {
  id: string;
  inbox: string | null;
}

/** Publications read for the trailers of one type; `-n` counts matching commits only. */
const TRAILER_RECORDS_READ = 2000;

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The records of type `typeName` published on `ref`, newest first, from the trailers of its
 * history: how a type that keeps no archive knows a change is published. One bounded read.
 */
export async function trailerRecordsAt(
  git: CompanionGit,
  ref: string,
  typeName: string,
  isRecordId: (id: string) => boolean = () => true,
): Promise<TrailerRecord[]> {
  const prefix = `${typeName}/`;
  const log = await git.run([
    "log",
    `-n${TRAILER_RECORDS_READ}`,
    "--fixed-strings",
    `--grep=${ARTIFACT_TRAILER}: ${prefix}`,
    `--format=%(trailers:key=${INBOX_TRAILER},valueonly,separator=%x09)%x1f%(trailers:key=${ARTIFACT_TRAILER},valueonly,separator=%x09)`,
    "--end-of-options",
    ref,
  ]);
  if (log.status !== 0) return [];
  return outputLines(log.stdout).flatMap((line) => {
    const [inboxes = "", values = ""] = line.split("\x1f");
    const inbox = inboxes.split("\t")[0]!.trim();
    return values
      .split("\t")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(prefix) && isRecordId(value.slice(prefix.length)))
      .map((value) => ({
        id: value.slice(prefix.length),
        inbox: COMMIT_ID.test(inbox) ? inbox : null,
      }));
  });
}
