import { readFrictionSwitch } from "../../runtime/friction-switch";
import { describeFingerprint } from "./describe";
import { readFrictionSummary, type FrictionWindow } from "./summary";
import type { FrictionView } from "./view-model";

/** Reads only: no file or folder is created. */
export function readFrictionView(companionPath: string, window: FrictionWindow): FrictionView {
  const summary = readFrictionSummary(companionPath, window);
  return {
    ...summary,
    recording: readFrictionSwitch(window.homeDir),
    days: window.days,
    groups: summary.groups.map((group) => ({
      ...group,
      title: describeFingerprint(group.fingerprint),
    })),
  };
}
