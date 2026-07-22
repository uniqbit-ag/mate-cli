import type { FinisherFactory } from "./finisher";
import { openspecFinisher } from "./openspec";

/**
 * Artifact-kind → finisher factory. openspec is the only kind for now; a future ADR
 * finisher registers here and is selected via `--type`, with no engine changes.
 */
export const FINISHERS: Record<string, FinisherFactory> = {
  openspec: openspecFinisher,
};

export const DEFAULT_FINISHER_TYPE = "openspec";

export function selectFinisher(type: string): FinisherFactory | undefined {
  return FINISHERS[type];
}

export function knownFinisherTypes(): string[] {
  return Object.keys(FINISHERS);
}
