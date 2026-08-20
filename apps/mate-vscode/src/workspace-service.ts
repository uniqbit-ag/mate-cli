import {
  type MateCliClientOptions,
  type MateCliResult,
  MateCliUnavailableError,
  runMateCli,
} from "./mate-cli-client";
import {
  type MaterializedWorkspaceV1,
  parseMaterializedWorkspace,
  parseSessionEnvelopeResolution,
  parseWorkspaceInventory,
  type SessionEnvelopeResolutionV1,
  type WorkspaceInventoryV1,
} from "./schema";

export interface MaterializeRequest {
  repositoryId: string;
  companionPath: string;
}

export interface ResolveSessionEnvelopeRequest {
  host: string;
  cwd?: string;
  activePath?: string;
  workspaceRoots?: readonly string[];
  repositoryId?: string;
  repositoryPath?: string;
  companionPath?: string;
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

  async resolveSessionEnvelope(
    request: ResolveSessionEnvelopeRequest,
  ): Promise<SessionEnvelopeResolutionV1> {
    const args = ["workspace", "resolve", "--json", "--host", request.host];
    if (request.cwd) args.push("--cwd", request.cwd);
    if (request.activePath) args.push("--active", request.activePath);
    for (const workspaceRoot of request.workspaceRoots ?? []) {
      args.push("--workspace-root", workspaceRoot);
    }
    if (request.companionPath) args.push("--companion", request.companionPath);
    if (request.repositoryId) args.push("--repository", request.repositoryId);
    if (request.repositoryPath) args.push("--repository-path", request.repositoryPath);

    const result = await this.deps.runMateCli(args, this.deps.options());
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `mate workspace resolve --json exited with code ${result.code}`,
      );
    }
    return parseSessionEnvelopeResolution(result.stdout);
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
