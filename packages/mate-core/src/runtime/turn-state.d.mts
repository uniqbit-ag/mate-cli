import type { Stats } from "node:fs";

export function turnStateDir(mateHome: string): string;
export function sessionFileName(session: string): string;
export function isPrivateDir(
  stat: Pick<Stats, "isDirectory" | "uid" | "mode">,
  uid?: number,
): boolean;
export function mayStartStep(prompt: string): boolean;
export function mayReportStep(command: string): boolean;
