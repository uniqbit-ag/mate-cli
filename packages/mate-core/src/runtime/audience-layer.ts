import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { mateHome } from "./runtime-directory";

/**
 * Audience Layer locations. A layer holds one audience's plugin contributions
 * for one companion, rendered for managed launches only. It lives under Mate's
 * machine-local state, never inside a repository: a layer inside the companion
 * would be readable by every session with companion access, and could carry
 * values resolved from plugin configuration.
 *
 *   <state>/audience-layers/<companion-key>/<audience>/
 *     <fingerprint>/   one complete render; never changed once renamed into place
 *     current          symlink to the newest complete render
 *
 * A launch attaches the fingerprint directory itself, so a later re-render
 * never changes what a running session reads.
 */

/** Mirrors `AUDIENCE_NAME_PATTERN`; repeated here because `runtime/` imports nothing from core. */
const SAFE_AUDIENCE = /^[a-z][a-z0-9-]{0,63}$/;

export const CURRENT_LAYER_LINK = "current";

export function audienceLayersRoot(homeDir?: string): string {
  return path.join(mateHome(homeDir), "state", "audience-layers");
}

/** A short, stable key for one companion checkout: a hash of its resolved path. */
export function companionLayerKey(companionPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(companionPath)).digest("hex").slice(0, 16);
}

/** The directory holding one audience's layers for one companion. */
export function audienceLayerDir(
  companionPath: string,
  audience: string,
  homeDir?: string,
): string {
  if (!SAFE_AUDIENCE.test(audience)) {
    throw new Error(`"${audience}" is not a valid audience name for a layer directory`);
  }
  return path.join(audienceLayersRoot(homeDir), companionLayerKey(companionPath), audience);
}

/** The newest complete layer of `audience`, or `null` when none was rendered on this machine. */
export function currentAudienceLayer(
  companionPath: string,
  audience: string,
  homeDir?: string,
): string | null {
  try {
    const dir = audienceLayerDir(companionPath, audience, homeDir);
    const layer = path.join(dir, fs.readlinkSync(path.join(dir, CURRENT_LAYER_LINK)));
    return fs.existsSync(layer) ? layer : null;
  } catch {
    return null;
  }
}

const MANAGED_MARKER = new RegExp(
  `^<!-- ${FRAMEWORK_NAME}:managed:[^\\n]* (?:start|end) -->$`,
  "gm",
);

/** A layer guidance document's text, managed-block markers removed; empty when absent. */
export function layerGuidanceText(text: string): string {
  return text
    .replace(MANAGED_MARKER, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `file` (`CLAUDE.md`, `AGENTS.md`) of the layer at `root`, markers removed; empty when absent. */
export function readLayerGuidanceSync(root: string, file: string): string {
  try {
    return layerGuidanceText(fs.readFileSync(path.join(root, file), "utf8"));
  } catch {
    return "";
  }
}
