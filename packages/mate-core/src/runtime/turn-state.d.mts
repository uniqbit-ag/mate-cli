import type { Stats } from "node:fs";

export function turnStateDir(mateHome: string): string;
export function sessionFileName(session: string): string;
export function isPrivateDir(
  stat: Pick<Stats, "isDirectory" | "uid" | "mode">,
  uid?: number,
): boolean;
export function privateTurnDir(dir: string): Promise<string>;
export function appendTurnNote(file: string, note: object): Promise<void>;
export function readTurnNotes(file: string): Promise<Record<string, unknown>[]>;
export function turnSession(env: Record<string, string | undefined>): string | undefined;
export function mayStartStep(prompt: string): boolean;
export function mayReportStep(command: string): boolean;
