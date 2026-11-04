import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../framework";
import { YamlFileStore } from "./orchestrator/yaml-file-store";

/**
 * A member's answer to a tool their companion recommends (RTK, TokenSave,
 * Graphify, Context Mode). The companion selects the capability for the team;
 * whether its tool is installed on this machine is the member's call, kept per
 * user and companion so `mate install` asks once.
 */
export type MemberChoice = "accepted" | "declined";

/** Capability id → the member's answer. Absent ids are undecided. */
export type MemberChoices = Record<string, MemberChoice>;

interface MemberChoicesFile {
  companions?: Record<string, MemberChoices>;
}

export function defaultMemberChoicesPath(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`, "member-choices.yaml");
}

export class MemberChoicesStore extends YamlFileStore<MemberChoicesFile> {
  constructor(configPath = defaultMemberChoicesPath()) {
    super(configPath);
  }

  protected onMissing(): Promise<MemberChoicesFile> {
    return Promise.resolve({});
  }

  async read(companionPath: string): Promise<MemberChoices> {
    const file = (await this.load()) ?? {};
    return { ...file.companions?.[path.resolve(companionPath)] };
  }

  async record(companionPath: string, updates: MemberChoices): Promise<MemberChoices> {
    const file = (await this.load()) ?? {};
    const key = path.resolve(companionPath);
    const companions = { ...file.companions };
    companions[key] = { ...companions[key], ...updates };
    await this.save({ ...file, companions });
    return companions[key];
  }
}

export type ReadMemberChoices = (companionPath: string) => Promise<MemberChoices>;

export const readMemberChoices: ReadMemberChoices = (companionPath) =>
  new MemberChoicesStore().read(companionPath);

/**
 * True when the member declined every listed capability for this companion.
 * `mate setup` then leaves the tool uninstalled instead of asking again.
 */
export async function isDeclinedByMember(
  companionPath: string,
  capabilities: string[],
  read: ReadMemberChoices = readMemberChoices,
): Promise<boolean> {
  if (capabilities.length === 0) return false;
  const choices = await read(companionPath);
  return capabilities.every((id) => choices[id] === "declined");
}
