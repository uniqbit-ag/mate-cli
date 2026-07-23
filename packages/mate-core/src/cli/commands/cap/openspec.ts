import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { resolveForCapability } from "../../../lib/orchestrator/framework-context";
import { getEffectiveCliTools } from "../../../lib/orchestrator/setup-compatibilities";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";

export interface OpenspecCapDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
}

export function readOpenSpecProjectSchema(companionPath: string): string | undefined {
  for (const candidate of ["config.yaml", "config.yml"]) {
    const configPath = path.join(companionPath, "openspec", candidate);
    try {
      const parsed = parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.schema === "string") {
        const schema = parsed.schema.trim();
        if (schema.length > 0) return schema;
      }
    } catch {
      // Missing or malformed config should not block the underlying openspec call.
    }
  }

  return undefined;
}

export function injectSchemaForBrokenOpenSpecCommands(
  args: string[],
  schema: string | undefined,
): string[] {
  if (args[0] !== "templates") return args;
  if (!schema || args.includes("--schema")) return args;
  return [args[0], "--schema", schema, ...args.slice(1)];
}

/**
 * @command mate cap openspec [...args]
 * @description Forwards `[...args]` to the `openspec` CLI. Requires the
 * `openspec` capability to be enabled in `.mate/config/framework.yaml`. Runs
 * from the companion root when the resolved `openspec` tool config sets
 * `redirectCwd: companionRoot`, otherwise from the current working directory.
 * Also works around broken upstream `openspec templates` invocations by
 * injecting `--schema <schema>` (read from `openspec/config.yaml`) when the
 * caller didn't supply one.
 * @remarks The child process's exit code is propagated via `process.exitCode`.
 */
export async function runOpenspecCapCommand(
  args: string[],
  deps: OpenspecCapDeps = {},
): Promise<void> {
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const { companionPath, configStore } = await resolveForCapability(process.cwd());
  const config = await configStore.load();

  const capability = (config.capabilities ?? []).find(
    (entry: CapabilityConfig) => entry.name === "openspec",
  );
  if (!capability) {
    process.stderr.write("openspec capability is not enabled in .mate/config/framework.yaml\n");
    process.exitCode = 1;
    return;
  }

  const openspecTool = getEffectiveCliTools(config).find((entry) => entry.name === "openspec");
  const cwd = openspecTool?.redirectCwd === "companionRoot" ? companionPath : process.cwd();
  const forwardedArgs = injectSchemaForBrokenOpenSpecCommands(
    args,
    readOpenSpecProjectSchema(companionPath),
  );

  const result = spawnSync("openspec", forwardedArgs, { cwd, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Failed to run openspec: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== null) {
    process.exitCode = result.status;
  }
}
