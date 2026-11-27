import type { CapabilityConfig } from "./types";

export function hasOpenspecCapability(capabilities: CapabilityConfig[] = []): boolean {
  return capabilities.some((capability) => capability.name === "openspec");
}

export function hasTokensaveCapability(capabilities: CapabilityConfig[] = []): boolean {
  return capabilities.some((capability) => capability.name === "tokensave");
}
