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
