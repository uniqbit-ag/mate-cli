// oxlint-disable no-await-in-loop -- modules must initialize in their fixed execution order
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import { AddDirPlugin } from "./add-dir";
import { CompanionHooksPlugin } from "./companion-hooks";
import { CompanionPlugin } from "./companion";

// Compose the implementation modules in the execution order the previously
// copied plugin files were discovered in (alphabetical file order:
// mate-add-dir, mate-companion-hooks, mate-companion).
const MODULES: Plugin[] = [AddDirPlugin, CompanionHooksPlugin, CompanionPlugin];

type HookValue = Hooks[keyof Hooks];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chainHooks(first: HookValue, second: HookValue): HookValue {
  if (typeof first === "function" && typeof second === "function") {
    return (async (...args: unknown[]) => {
      await (first as (...values: unknown[]) => Promise<unknown>)(...args);
      await (second as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as HookValue;
  }

  if (isRecord(first) && isRecord(second)) {
    return { ...first, ...second } as HookValue;
  }

  return second;
}

/**
 * Aggregate regular Mate OpenCode plugin. Loaded through the package's
 * `./server` export; stays inert when the session is not Mate-managed
 * because every composed module checks the Mate launch environment itself.
 */
export const MateOpenCodePlugin: Plugin = async (input: PluginInput) => {
  const merged: Record<string, HookValue> = {};

  for (const module of MODULES) {
    const hooks = await module(input);
    for (const [name, value] of Object.entries(hooks) as Array<[string, HookValue]>) {
      if (value === undefined) continue;
      const existing = merged[name];
      merged[name] = existing === undefined ? value : chainHooks(existing, value);
    }
  }

  return merged as Hooks;
};

export default MateOpenCodePlugin;
