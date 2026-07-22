import { version } from "../package.json";
import { setFallbackDistribution } from "../src/distribution";
import { createGraphifyPlugin } from "../src/tools/setup/capabilities/graphify";
import { createHeadroomPlugin } from "../src/tools/setup/capabilities/headroom";
import { createOpenspecPlugin } from "../src/tools/setup/capabilities/openspec";
import { createReactDoctorPlugin } from "../src/tools/setup/capabilities/react-doctor";
import { createTokensavePlugin } from "../src/tools/setup/capabilities/tokensave";
import { createBunPlugin } from "../src/tools/setup/package-managers/bun";
import { createUvPlugin } from "../src/tools/setup/package-managers/uv";
import type { Plugin, PluginRegistration } from "../src/tools/setup/plugin";
import { createGitignorePlugin } from "../src/tools/setup/plugins/gitignore";
import { createClaudePlugin } from "../src/tools/setup/providers/claude";
import { createOpenCodePlugin } from "../src/tools/setup/providers/opencode";
import { PluginRegistry } from "../src/tools/setup/registry";

// Test-harness default: a mate-shaped distribution (mirroring the
// @uniqbit/mate bin's assembly) so framework code paths that read the active
// distribution work without each test calling createMate. Production bins
// never rely on this — they call createMate first.
function buildTestPluginEntries(): PluginRegistration[] {
  const providers: Plugin[] = [createClaudePlugin(), createOpenCodePlugin()];
  const bun = createBunPlugin();
  const uv = createUvPlugin();
  const capabilities: Plugin[] = [
    createOpenspecPlugin(),
    createReactDoctorPlugin(),
    createTokensavePlugin(),
    createHeadroomPlugin(),
    createGraphifyPlugin(),
  ];
  return [
    ...providers,
    { plugin: bun, policy: "required" },
    { plugin: uv, policy: "required" },
    ...capabilities,
    createGitignorePlugin("mate"),
  ];
}

setFallbackDistribution(() => ({
  config: {
    name: "mate",
    legacyNames: ["kizuna", "axon"],
    runtime: "bun",
    supportedAdapters: ["claude", "opencode"],
    version,
  },
  registry: new PluginRegistry(buildTestPluginEntries()),
}));
