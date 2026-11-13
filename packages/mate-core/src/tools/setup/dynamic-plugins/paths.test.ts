import { describe, expect, test } from "bun:test";

import {
  audienceWorkspacesRoot,
  dynamicPluginsWorkspaceRoot,
  pluginLocalOverridesPath,
  pluginPackageRoot,
  PLUGIN_AUDIENCE_NPMRC_GITIGNORE_ENTRY,
  PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY,
  PLUGIN_WORKSPACE_NPMRC_GITIGNORE_ENTRY,
} from "./paths";

describe("plugin paths", () => {
  test("the shared workspace lives under .mate/plugins", () => {
    expect(dynamicPluginsWorkspaceRoot("/companion")).toBe("/companion/.mate/plugins");
  });

  test("package roots resolve into the shared workspace's node_modules", () => {
    expect(pluginPackageRoot("/companion", "@acme/custom-plugin")).toBe(
      "/companion/.mate/plugins/node_modules/@acme/custom-plugin",
    );
    expect(pluginPackageRoot("/companion", "plain-plugin")).toBe(
      "/companion/.mate/plugins/node_modules/plain-plugin",
    );
  });

  test("an audience workspace lives under .mate/plugins/audiences/<name>", () => {
    expect(dynamicPluginsWorkspaceRoot("/companion", null)).toBe("/companion/.mate/plugins");
    expect(dynamicPluginsWorkspaceRoot("/companion", "ba")).toBe(
      "/companion/.mate/plugins/audiences/ba",
    );
    expect(audienceWorkspacesRoot("/companion")).toBe("/companion/.mate/plugins/audiences");
  });

  test("an audience plugin's package root resolves into its audience workspace", () => {
    expect(pluginPackageRoot("/companion", "@acme/reader", "ba")).toBe(
      "/companion/.mate/plugins/audiences/ba/node_modules/@acme/reader",
    );
  });

  test("local overrides live in .mate/config/plugins.local.yaml", () => {
    expect(pluginLocalOverridesPath("/companion")).toBe(
      "/companion/.mate/config/plugins.local.yaml",
    );
  });

  test("gitignore entry constants match the local override and local npmrc paths", () => {
    expect(PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY).toBe(".mate/config/plugins.local.yaml");
    expect(PLUGIN_WORKSPACE_NPMRC_GITIGNORE_ENTRY).toBe(".mate/plugins/.npmrc");
    expect(PLUGIN_AUDIENCE_NPMRC_GITIGNORE_ENTRY).toBe(".mate/plugins/audiences/*/.npmrc");
  });
});
