import {
  type MateCliClientOptions,
  type MateCliResult,
  MateCliUnavailableError,
  runMateCli,
} from "./mate-cli-client";
import {
  type MaterializedWorkspaceV1,
  parseMaterializedWorkspace,
  parseWorkspaceInventory,
  type WorkspaceInventoryV1,
} from "./schema";

export interface MaterializeRequest {
  repositoryId: string;
  companionPath: string;
}

export interface WorkspaceServiceDeps {
  runMateCli: (args: string[], options: MateCliClientOptions) => Promise<MateCliResult>;
  options: () => MateCliClientOptions;
}

function defaultDeps(options: () => MateCliClientOptions): WorkspaceServiceDeps {
  return { runMateCli, options };
}

/** Thin wrapper turning `mate` child-process output into validated response objects. Never touches disk itself. */
export class WorkspaceService {
  private readonly deps: WorkspaceServiceDeps;

  constructor(optionsOrDeps: (() => MateCliClientOptions) | WorkspaceServiceDeps) {
    this.deps = typeof optionsOrDeps === "function" ? defaultDeps(optionsOrDeps) : optionsOrDeps;
  }

  async fetchInventory(): Promise<WorkspaceInventoryV1> {
    const result = await this.deps.runMateCli(["workspace", "list", "--json"], this.deps.options());
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `mate workspace list --json exited with code ${result.code}`,
      );
    }
    return parseWorkspaceInventory(result.stdout);
  }

  async materialize(request: MaterializeRequest): Promise<MaterializedWorkspaceV1> {
    const result = await this.deps.runMateCli(
      [
        "workspace",
        "materialize",
        "--repository",
        request.repositoryId,
        "--companion",
        request.companionPath,
        "--json",
      ],
      this.deps.options(),
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `mate workspace materialize --json exited with code ${result.code}`,
      );
    }
    return parseMaterializedWorkspace(result.stdout);
  }

  /** Resolves true only when `mate` itself is executable — distinct from a healthy inventory response. */
  async isMateAvailable(): Promise<boolean> {
    try {
      await this.deps.runMateCli(["--version"], this.deps.options());
      return true;
    } catch (error) {
      if (error instanceof MateCliUnavailableError) return false;
      throw error;
    }
  }
}
