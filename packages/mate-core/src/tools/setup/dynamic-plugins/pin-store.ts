import { YamlFileStore } from "../../../lib/orchestrator/yaml-file-store";
import { pluginPinFilePath } from "./paths";

/** Committed record of one declared plugin's resolved install. */
export interface PluginPin {
  package: string;
  declaredVersion: string;
  resolvedVersion: string;
  integrity?: string;
}

export interface PluginPinFile {
  plugins: PluginPin[];
}

export class PluginPinStore extends YamlFileStore<PluginPinFile> {
  constructor(companionPath: string) {
    super(pluginPinFilePath(companionPath));
  }

  override async load(): Promise<PluginPinFile> {
    const parsed = await super.load();
    return { plugins: Array.isArray(parsed?.plugins) ? parsed.plugins : [] };
  }

  protected onMissing(): Promise<PluginPinFile> {
    // The pin file appears only once install records a resolved plugin.
    return Promise.resolve({ plugins: [] });
  }
}
