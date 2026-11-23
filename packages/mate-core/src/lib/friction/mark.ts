import { findEvent, findFingerprint, findReport, readReportIds } from "../../runtime/friction-log";
import {
  FrictionStateFileError,
  type FrictionStatesFile,
  readFrictionStates,
  updateFrictionStates,
} from "../../runtime/friction-state";
import type {
  FrictionState,
  FrictionStateOrigin,
  MarkState,
} from "../../runtime/friction-vocabulary";
import type { LockOptions } from "../../runtime/session-registry";
import { cut, FrictionRefusal, refuseSecrets, type SecretScan } from "./fields";

export interface MarkInput {
  note?: string;
  link?: string;
  by: FrictionStateOrigin;
}

export interface MarkDeps {
  homeDir?: string;
  now?: Date;
  scan?: SecretScan;
  lock?: LockOptions;
}

export type MarkResult =
  | { ok: true; target: string; state: FrictionState | null }
  | { ok: false; code: string; reason: string };

const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unknownTarget = (target: string) =>
  new FrictionRefusal(
    "unknown-target",
    `${target} is no recorded fingerprint and no Free Report; nothing was changed.`,
  );

const textOrNull = (text: string | undefined) => (text?.trim() ? cut(text) : null);

function checkLink(link: string | null, state: MarkState): void {
  if (link === null) return;
  if (state !== "reported") {
    throw new FrictionRefusal(
      "link-needs-reported",
      "A link is kept only with the state reported (--state reported); nothing was changed.",
    );
  }
  let protocol: string;
  try {
    protocol = new URL(link).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new FrictionRefusal(
      "invalid-link",
      "The link must be an http or https URL; nothing was changed.",
    );
  }
}

function resolveTarget(
  target: string,
  known: { fingerprints: object; reports: object },
  homeDir?: string,
): "fingerprints" | "reports" {
  if (Object.hasOwn(known.fingerprints, target)) return "fingerprints";
  if (Object.hasOwn(known.reports, target)) return "reports";
  if (!REPORT_ID.test(target)) {
    if (!findFingerprint(target, { homeDir })) throw unknownTarget(target);
    return "fingerprints";
  }
  const report = findReport(target, { homeDir });
  if (!report) throw unknownTarget(target);
  if (report.eventId) {
    const event = findEvent(report.eventId, { homeDir });
    throw new FrictionRefusal(
      "report-on-event",
      `${target} is a report on an event; it follows the state of its fingerprint${event ? ` ${event.fingerprint}` : ""}. Mark that fingerprint instead; nothing was changed.`,
    );
  }
  return "reports";
}

function forgetExpiredReports(
  states: FrictionStatesFile,
  idsReadBeforeScan: string[],
  retained: Set<string>,
): void {
  for (const id of idsReadBeforeScan) {
    if (!retained.has(id)) delete states.reports[id];
  }
}

/**
 * Sets or, with `open`, clears the Friction State of a fingerprint or a Free Report. The checks
 * live here once for every caller; the Friction Log is never written.
 */
export async function markFriction(
  target: string,
  state: MarkState,
  input: MarkInput,
  deps: MarkDeps = {},
): Promise<MarkResult> {
  try {
    const note = textOrNull(input.note);
    const link = textOrNull(input.link);
    checkLink(link, state);
    const known = readFrictionStates(deps.homeDir);
    const family = resolveTarget(target, known, deps.homeDir);
    if (note !== null || link !== null) await refuseSecrets("The mark", [note, link], deps.scan);
    const retained =
      Object.keys(known.reports).length > 0 ? readReportIds({ homeDir: deps.homeDir }) : null;
    if (family === "reports" && retained && !retained.has(target)) {
      throw unknownTarget(target);
    }
    const next: FrictionState | null =
      state === "open"
        ? null
        : {
            state,
            at: (deps.now ?? new Date()).toISOString(),
            by: input.by,
            note,
            link,
          };
    await updateFrictionStates(
      (states) => {
        if (retained) forgetExpiredReports(states, Object.keys(known.reports), retained);
        if (next) states[family][target] = next;
        else delete states[family][target];
      },
      { homeDir: deps.homeDir, lock: deps.lock },
    );
    return { ok: true, target, state: next };
  } catch (error) {
    if (error instanceof FrictionRefusal) {
      return { ok: false, code: error.code, reason: error.message };
    }
    if (error instanceof FrictionStateFileError) {
      return {
        ok: false,
        code: "state-file-damaged",
        reason: `${error.message}; it was left unchanged and nothing was marked. Repair or delete it to mark again.`,
      };
    }
    return {
      ok: false,
      code: "write-failed",
      reason: `The Friction State could not be written: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
