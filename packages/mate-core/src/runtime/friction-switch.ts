import fs from "node:fs";
import path from "node:path";

import { frictionLogDir } from "./friction-log";

/** The Friction Switch: one machine-local setting beside the log; off unless a person turned it on. */

export function frictionSwitchFile(homeDir?: string): string {
  return path.join(frictionLogDir(homeDir), "settings.json");
}

/** Never throws and creates nothing; an absent or malformed file reads as off. */
export function readFrictionSwitch(homeDir?: string): boolean {
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(frictionSwitchFile(homeDir), "utf8"));
    return (settings as { recording?: unknown } | null)?.recording === true;
  } catch {
    return false;
  }
}

export function writeFrictionSwitch(recording: boolean, homeDir?: string): void {
  const file = frictionSwitchFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ v: 1, recording })}\n`, "utf8");
  fs.renameSync(temporary, file);
}
