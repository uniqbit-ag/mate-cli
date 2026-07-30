import { describe, expect, test } from "bun:test";

import {
  dynamicPluginsWorkspaceRoot,
  pluginLocalOverridesPath,
  pluginPackageRoot,
  PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY,
  PLUGIN_WORKSPACE_NODE_MODULES_GITIGNORE_ENTRY,
} from "./paths";

describe("plugin paths", () => {
  test("the shared workspace lives under .mate/dependencies/plugins", () => {
    expect(dynamicPluginsWorkspaceRoot("/companion")).toBe("/companion/.mate/dependencies/plugins");
  });

  test("package roots resolve into the shared workspace's node_modules", () => {
    expect(pluginPackageRoot("/companion", "@acme/custom-plugin")).toBe(
      "/companion/.mate/dependencies/plugins/node_modules/@acme/custom-plugin",
    );
    expect(pluginPackageRoot("/companion", "plain-plugin")).toBe(
      "/companion/.mate/dependencies/plugins/node_modules/plain-plugin",
    );
  });

  test("local overrides live in .mate/config/plugins.local.yaml", () => {
    expect(pluginLocalOverridesPath("/companion")).toBe(
      "/companion/.mate/config/plugins.local.yaml",
    );
  });

  test("gitignore entry constants match the local override and shared node_modules paths", () => {
    expect(PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY).toBe(".mate/config/plugins.local.yaml");
    expect(PLUGIN_WORKSPACE_NODE_MODULES_GITIGNORE_ENTRY).toBe(
      ".mate/dependencies/plugins/node_modules/",
    );
  });
});
