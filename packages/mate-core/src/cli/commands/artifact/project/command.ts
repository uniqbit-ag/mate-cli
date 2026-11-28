import {
  projectChange,
  type ProjectionResult,
  type ProjectDeps,
} from "../../../../lib/delivery/staging/project";
import { type BooleanFlagSet, parseFlags, positionalArgs } from "../../../parse-flags";
import { resolveDeliveryEnvironment, type DeliveryEnvironmentDeps } from "../delivery/environment";
import { commandOutput } from "../delivery/output";

export interface ProjectCommandDeps extends DeliveryEnvironmentDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  project?: (companionPath: string, change: string, deps: ProjectDeps) => Promise<ProjectionResult>;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

function renderHuman(result: ProjectionResult): string[] {
  return [
    result.message,
    ...result.chain.map((member) => `  applied: ${member.name} (${member.source})`),
    ...result.files.map((file) => `  ${file.path}  ${file.file}`),
  ];
}

/**
 * @command mate artifact project <change>
 * @description Shows the canonical specs as they will read once the change's `dependsOn` chain
 * is published. In a temporary worktree of the default branch the unpublished dependencies,
 * from this checkout or else the pending branch, are applied in dependency order with
 * publication's code (stale check, `openspec archive`, validation), and the specs they change
 * are copied to a temporary folder. Read-only: nothing is committed or pushed, and the
 * checkout is untouched. In Git mode `auto` the default and pending branches are fetched first.
 * @flags
 * - `--json` — emit a {@link ProjectionResult}: `chain`, the temporary `dir`, and `files` with
 *   each spec's path, copy and content.
 * @remarks A chain publication would refuse fails with publication's reason (`status:
 * "conflict"`) and exits non-zero.
 */
export async function runArtifactProjectCommand(
  argv: string[],
  deps: ProjectCommandDeps = {},
): Promise<void> {
  const { emitOut, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const [change, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (!change || extra.length > 0) {
    return refuse("mate: artifact project requires one change name.");
  }

  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const result = await (deps.project ?? projectChange)(environment.companionPath, change, {
    fetch: environment.gitAutoMode === true,
  });
  if (result.status !== "ok") refuse(result.message);
  if (flags.json === true) emitOut(JSON.stringify(result));
  else if (result.status === "ok") for (const line of renderHuman(result)) emitOut(line);
}
