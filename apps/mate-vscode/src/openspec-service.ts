import {
  type OpenSpecCliClientOptions,
  type OpenSpecCliResult,
  OpenSpecCliUnavailableError,
  runOpenSpecCli,
} from "./openspec-cli-client";
import {
  type OpenSpecChangeSummary,
  parseOpenSpecChangeList,
  parseOpenSpecChangeRoot,
} from "./openspec-schema";

export interface OpenSpecServiceDeps {
  runOpenSpecCli: (args: string[], options: OpenSpecCliClientOptions) => Promise<OpenSpecCliResult>;
  options: () => OpenSpecCliClientOptions;
}

function defaultDeps(options: () => OpenSpecCliClientOptions): OpenSpecServiceDeps {
  return { runOpenSpecCli, options };
}

/** Thin wrapper turning `openspec` child-process output into validated response objects. Never touches disk itself. */
export class OpenSpecService {
  private readonly deps: OpenSpecServiceDeps;

  constructor(optionsOrDeps: (() => OpenSpecCliClientOptions) | OpenSpecServiceDeps) {
    this.deps = typeof optionsOrDeps === "function" ? defaultDeps(optionsOrDeps) : optionsOrDeps;
  }

  /**
   * `openspec list --json` already reports each change's task progress — no
   * per-change follow-up call needed. `cwd` overrides the configured
   * options' cwd — the Active Changes view calls this once per companion,
   * since `openspec` resolves its root (and therefore its changes) from cwd.
   */
  async listChanges(cwd?: string): Promise<OpenSpecChangeSummary[]> {
    const options = cwd ? { ...this.deps.options(), cwd } : this.deps.options();
    const result = await this.deps.runOpenSpecCli(["list", "--json"], options);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `openspec list --json exited with code ${result.code}`,
      );
    }
    return parseOpenSpecChangeList(result.stdout);
  }

  /** Resolves a change's on-disk root directory, for the "open change" action to locate its proposal file. */
  async getChangeRoot(name: string, cwd?: string): Promise<string> {
    const options = cwd ? { ...this.deps.options(), cwd } : this.deps.options();
    const result = await this.deps.runOpenSpecCli(["status", "--change", name, "--json"], options);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `openspec status --change ${name} --json exited with code ${result.code}`,
      );
    }
    return parseOpenSpecChangeRoot(result.stdout);
  }

  /** Resolves true only when `openspec` itself is executable — distinct from a well-formed change list. */
  async isOpenSpecAvailable(): Promise<boolean> {
    try {
      await this.deps.runOpenSpecCli(["--version"], this.deps.options());
      return true;
    } catch (error) {
      if (error instanceof OpenSpecCliUnavailableError) return false;
      throw error;
    }
  }
}
