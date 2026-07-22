/**
 * Versioned companion guidance contract. The CLI builds the guidance data
 * from its playbooks at launch time and delivers it through the
 * `MATE_GUIDANCE_JSON` launch environment variable (see `MATE_ENV`); the
 * OpenCode plugin parses and validates it at session start.
 */
export const GUIDANCE_FILE_VERSION = 1;

/** Marker every injected companion guidance block must contain. */
export const COMPANION_POLICY_MARKER = "<companion-policy ";
/** Marker every non-empty codebase exploration guidance block must contain. */
export const CODEBASE_EXPLORATION_MARKER = "<codebase-exploration-rules ";

export type MateGuidanceFile = {
  version: number;
  companionGuidance: string;
  codebaseExplorationGuidance: string;
  errors: string[];
};

export type GuidanceValidation = {
  guidance: MateGuidanceFile;
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyGuidance(errors: string[]): GuidanceValidation {
  return {
    guidance: {
      version: GUIDANCE_FILE_VERSION,
      companionGuidance: "",
      codebaseExplorationGuidance: "",
      errors,
    },
    errors,
  };
}

/**
 * Validate an already-parsed guidance value against the versioned contract.
 * Returns the normalized guidance data plus every contract violation found.
 */
export function validateGuidanceData(value: unknown): GuidanceValidation {
  if (!isRecord(value)) {
    return emptyGuidance(["guidance data is not a JSON object"]);
  }

  const errors = Array.isArray(value.errors)
    ? value.errors.filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
    : [];

  if (value.version !== GUIDANCE_FILE_VERSION) {
    errors.push("unsupported guidance data version");
  }

  const companionGuidance =
    typeof value.companionGuidance === "string" ? value.companionGuidance : "";
  if (!companionGuidance.trim()) {
    errors.push("missing injected companion guidance");
  } else if (!companionGuidance.includes(COMPANION_POLICY_MARKER)) {
    errors.push("injected companion guidance is malformed");
  }

  if (typeof value.codebaseExplorationGuidance !== "string") {
    errors.push("missing injected codebase exploration guidance");
  }
  const codebaseExplorationGuidance =
    typeof value.codebaseExplorationGuidance === "string" ? value.codebaseExplorationGuidance : "";
  if (
    codebaseExplorationGuidance.trim() &&
    !codebaseExplorationGuidance.includes(CODEBASE_EXPLORATION_MARKER)
  ) {
    errors.push("injected codebase exploration guidance is malformed");
  }

  return {
    guidance: {
      version: GUIDANCE_FILE_VERSION,
      companionGuidance,
      codebaseExplorationGuidance,
      errors,
    },
    errors,
  };
}

/**
 * Parse raw guidance JSON (the `MATE_GUIDANCE_JSON` value) and validate it
 * against the contract.
 */
export function parseGuidanceContent(content: string): GuidanceValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return emptyGuidance(["guidance data is not valid JSON"]);
  }

  return validateGuidanceData(parsed);
}
