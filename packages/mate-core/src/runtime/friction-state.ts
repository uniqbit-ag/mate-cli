import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { frictionLogDir } from "./friction-log";
import { FRICTION_STATE_ORIGINS, FRICTION_STATES, type FrictionState } from "./friction-vocabulary";
import { withLock, type LockOptions } from "./session-registry";
import { writeAtomic } from "./write-atomic";

export interface FrictionStatesFile {
  v: 1;
  /** Fingerprint → its Friction State. */
  fingerprints: Record<string, FrictionState>;
  /** Free Report id → its Friction State. */
  reports: Record<string, FrictionState>;
}

export class FrictionStateFileError extends Error {}

export function frictionStateFile(homeDir?: string): string {
  return path.join(frictionLogDir(homeDir), "states.json");
}

const emptyStates = (): FrictionStatesFile => ({ v: 1, fingerprints: {}, reports: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stringOrNull = (value: unknown) => value === null || typeof value === "string";

/** As `toISOString` writes it; a zone-less time would parse as local time. */
const isUtcTime = (at: string) => {
  const time = Date.parse(at);
  return !Number.isNaN(time) && new Date(time).toISOString() === at;
};

function isFrictionState(value: unknown): value is FrictionState {
  return (
    isRecord(value) &&
    (FRICTION_STATES as readonly unknown[]).includes(value.state) &&
    typeof value.at === "string" &&
    isUtcTime(value.at) &&
    (FRICTION_STATE_ORIGINS as readonly unknown[]).includes(value.by) &&
    stringOrNull(value.note) &&
    stringOrNull(value.link)
  );
}

const isStateMap = (value: unknown): value is Record<string, FrictionState> =>
  isRecord(value) && Object.values(value).every(isFrictionState);

function parseStates(text: string, file: string): FrictionStatesFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrictionStateFileError(`${file} is not valid JSON`);
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    !isStateMap(parsed.fingerprints) ||
    !isStateMap(parsed.reports)
  ) {
    throw new FrictionStateFileError(`${file} is not a version 1 Friction State file`);
  }
  return { v: 1, fingerprints: parsed.fingerprints, reports: parsed.reports };
}

/** Never throws and creates nothing; a missing, unreadable or malformed file reads as no states. */
export function readFrictionStates(homeDir?: string): FrictionStatesFile {
  const file = frictionStateFile(homeDir);
  try {
    return parseStates(fs.readFileSync(file, "utf8"), file);
  } catch {
    return emptyStates();
  }
}

async function readStrictly(file: string): Promise<FrictionStatesFile> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStates();
    throw error;
  }
  return parseStates(text, file);
}

/** Read, change and write the states under the lock; `change` returns the value to hand back. */
export async function updateFrictionStates<T>(
  change: (states: FrictionStatesFile) => T,
  options: { homeDir?: string; lock?: LockOptions } = {},
): Promise<T> {
  const file = frictionStateFile(options.homeDir);
  return withLock(
    file,
    async () => {
      const states = await readStrictly(file);
      const before = JSON.stringify(states);
      const result = change(states);
      if (JSON.stringify(states) !== before) {
        await writeAtomic(file, `${JSON.stringify(states, null, 2)}\n`);
      }
      return result;
    },
    options.lock,
  );
}
