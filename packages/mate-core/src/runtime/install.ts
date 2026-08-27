import fs from "node:fs";
import path from "node:path";

/**
 * Identity of the running mate install, as the projection stamp records it.
 * It lives inside `runtime/` because the readers that judge a projection's
 * freshness — hooks and OpenCode plugins — may import nothing else from core;
 * `lib/package-paths` delegates here so the install has one definition.
 *
 * The manifest is read rather than imported: a static `package.json` import
 * would put a non-`runtime/` module in the isolation walk.
 */
export function mateInstallPath(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

export function mateVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(mateInstallPath(), "package.json"), "utf8"),
    );
    if (parsed && typeof parsed === "object") {
      const value = (parsed as { version?: unknown }).version;
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // fall through to the unknown marker
  }
  return "unknown";
}
