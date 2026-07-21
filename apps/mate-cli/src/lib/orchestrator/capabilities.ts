import type { CapabilityConfig } from "./types";

export function hasGraphifyCapability(capabilities: CapabilityConfig[] = []): boolean {
  return capabilities.some((capability) => capability.name === "graphify");
}

export function hasOpenspecCapability(capabilities: CapabilityConfig[] = []): boolean {
  return capabilities.some((capability) => capability.name === "openspec");
}

export function hasTokensaveCapability(capabilities: CapabilityConfig[] = []): boolean {
  return capabilities.some((capability) => capability.name === "tokensave");
}
