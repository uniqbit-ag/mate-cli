import { resolveInstallContext } from "../../../lib/install";
import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { usageDays } from "../../../lib/usage/window";
import { readEvents, type FrictionEvent } from "../../../runtime/friction-log";
import { FRICTION_CAPABILITY } from "../../../runtime/friction-recorder";
import { ensureCapabilityEnabled } from "../../plugin-commands";
import { writeJsonStdout } from "../../write-json-stdout";

interface FrictionGroup {
  fingerprint: string;
  events: number;
  sessions: number;
  /** The highest event count within one session. */
  maxPerSession: number;
  firstSeen: string;
  lastSeen: string;
  /** Mate version → event count. */
  versions: Record<string, number>;
}

interface FrictionSummary {
  events: number;
  sessions: number;
  groups: FrictionGroup[];
}

/** Grouped by fingerprint; repeats within one session rank first, then the event count. */
function summarizeFriction(events: FrictionEvent[]): FrictionSummary {
  const byFingerprint = new Map<string, FrictionEvent[]>();
  for (const event of events) {
    const grouped = byFingerprint.get(event.fingerprint);
    if (grouped) grouped.push(event);
    else byFingerprint.set(event.fingerprint, [event]);
  }
  const groups = [...byFingerprint].map(([fingerprint, grouped]): FrictionGroup => {
    const perSession = new Map<string, number>();
    const versions: Record<string, number> = {};
    for (const event of grouped) {
      perSession.set(event.sessionId, (perSession.get(event.sessionId) ?? 0) + 1);
      versions[event.mateVersion] = (versions[event.mateVersion] ?? 0) + 1;
    }
    const times = grouped.map((event) => event.at).toSorted();
    return {
      fingerprint,
      events: grouped.length,
      sessions: perSession.size,
      maxPerSession: Math.max(...perSession.values()),
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      versions,
    };
  });
  groups.sort((a, b) => b.maxPerSession - a.maxPerSession || b.events - a.events);
  return {
    events: events.length,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    groups,
  };
}

const DEFAULT_DAYS = 30;

function parseArgs(argv: string[]): { days: number; json: boolean } | string {
  let days = DEFAULT_DAYS;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      try {
        days = usageDays(arg === "--days" ? argv[++index] : arg.slice("--days=".length));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    } else return `Unknown argument: ${arg}`;
  }
  return { days, json };
}

function renderGroup(group: FrictionGroup): string {
  const versions = Object.entries(group.versions)
    .map(([version, count]) => `${version} ×${count}`)
    .join(", ");
  return [
    `  ${group.fingerprint}`,
    `    ${group.events} events in ${group.sessions} sessions, at most ${group.maxPerSession} in one session`,
    `    first ${group.firstSeen}, last ${group.lastSeen}; mate ${versions}`,
  ].join("\n");
}

export interface FrictionListDeps {
  resolveContext?: () => Promise<{ companionPath?: string; config: FrameworkConfig }>;
  homeDir?: string;
  now?: Date;
}

export async function runFrictionListCommand(
  argv: string[],
  deps: FrictionListDeps = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    process.exitCode = 1;
    return;
  }
  const context = await (deps.resolveContext ?? (() => resolveInstallContext()))();
  if (
    !(await ensureCapabilityEnabled(FRICTION_CAPABILITY, {
      loadConfig: async () => context.config,
    }))
  )
    return;
  const companion = context.companionPath ?? "";
  const summary = summarizeFriction(
    readEvents({ sinceDays: args.days, companion, homeDir: deps.homeDir, now: deps.now }),
  );

  if (args.json) {
    await writeJsonStdout({
      kind: "friction-list",
      version: 1,
      days: args.days,
      companion,
      events: summary.events,
      sessions: summary.sessions,
      groups: summary.groups,
    });
    return;
  }
  if (summary.events === 0) {
    console.log(`No friction recorded in the last ${args.days} days.`);
    return;
  }
  console.log(
    `Friction in the last ${args.days} days: ${summary.events} events in ${summary.sessions} sessions`,
  );
  for (const group of summary.groups) console.log(renderGroup(group));
}
