import fs from "node:fs";
import path from "node:path";

import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { errorMessage } from "../../runtime/error-message";
import { getTriagePlaybookPath } from "../package-paths";
import { maskSecretValues } from "../../runtime/secret-values";
import { renderTriageContext, writeFrictionSnapshot } from "./context";
import { findAgents, type FoundAgent } from "./launch";
import { createTriageSession } from "./session";

export interface TriageSessionFiles {
  dir: string;
  context: string;
  playbook: string;
  prompt: string;
}

interface PrepareTriageOptions {
  argv: string[];
  cwd: string;
  homeDir: string | undefined;
  now: Date;
  pathValue: string;
  env: Record<string, string | undefined>;
  /** Builds the doctor report for `cwd`; a throw is recorded in place of the report. */
  collectDoctor: (cwd: string) => Promise<unknown>;
}

export function seedPrompt(): string {
  return [
    `You are triaging a problem with ${FRAMEWORK_NAME} on this machine.`,
    "Read PLAYBOOK.md in this folder and follow it step by step.",
    "The machine facts and the recorded friction are described in context.md.",
  ].join(" ");
}

async function doctorSection(
  cwd: string,
  collect: (cwd: string) => Promise<unknown>,
): Promise<{ report: unknown } | { error: string }> {
  try {
    return { report: await collect(cwd) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function companionOf(doctor: { report: unknown } | { error: string }): string | null {
  if (!("report" in doctor) || !doctor.report || typeof doctor.report !== "object") return null;
  const { companionPath } = doctor.report as { companionPath?: unknown };
  return typeof companionPath === "string" && companionPath ? companionPath : null;
}

/** Writes a fresh triage session; nothing is written outside its folder except pruning old ones. */
export async function prepareTriageSession(
  options: PrepareTriageOptions,
): Promise<{ files: TriageSessionFiles; agents: FoundAgent[] }> {
  const { now, cwd } = options;
  const dir = createTriageSession({ homeDir: options.homeDir, now });
  const files: TriageSessionFiles = {
    dir,
    context: path.join(dir, "context.md"),
    playbook: path.join(dir, "PLAYBOOK.md"),
    prompt: path.join(dir, "prompt.md"),
  };
  const agents = findAgents(options.pathValue);
  const doctor = await doctorSection(cwd, options.collectDoctor);
  const friction = await writeFrictionSnapshot(dir, {
    companion: companionOf(doctor),
    homeDir: options.homeDir,
    now,
  });
  const { config } = getActiveDistribution();
  fs.writeFileSync(
    files.context,
    maskSecretValues(
      renderTriageContext({
        now,
        version: config.version,
        argv: options.argv,
        cwd,
        sessionDir: dir,
        issueRepository: config.issueRepository,
        agents,
        friction,
        doctor,
      }),
      options.env,
    ),
    "utf8",
  );
  fs.copyFileSync(getTriagePlaybookPath(), files.playbook);
  fs.writeFileSync(files.prompt, `${seedPrompt()}\n`, "utf8");
  return { files, agents };
}
