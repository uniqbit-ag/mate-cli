import { currentAudienceLayer } from "./audience-layer";
import { FRAMEWORK_NAME } from "./framework";
import { readWrapStateSync } from "./wrap-state";

/**
 * Session Audience: the audience a session gets beside base. One rule decides
 * it for every session:
 *
 *   - a bare session gets the audience its checkout is wrapped for, and never
 *     one from `MATE_AUDIENCE`;
 *   - a managed launch adopts the wrapped audience too; `MATE_AUDIENCE`
 *     selects one only for a checkout wrapped for none, and selecting another
 *     than the wrapped one is a conflict, refused before anything runs.
 *
 * `MATE_AUDIENCE` selects nothing when it names `base` or an audience the
 * companion does not declare; hydration reports the latter.
 *
 * Under `runtime/` so the bare-session hooks and the import-isolated OpenCode
 * plugin share it; the caller passes the declared audiences in.
 */

export type SessionAudience =
  | { kind: "base" }
  /** The checkout's wrap carries the audience; the session renders no layer of its own. */
  | { kind: "wrap"; audience: string }
  /** A managed launch's own audience, delivered through a launch layer. */
  | { kind: "launch"; audience: string }
  | { kind: "conflict"; wrapped: string; requested: string };

export interface SessionAudienceInput {
  session: "managed" | "bare";
  /** The audience the checkout is wrapped for; `null` for none or no checkout. */
  wrapped: string | null;
  /** `MATE_AUDIENCE`, as `readAudienceSelection` reads it. */
  requested: string | null;
  /** The companion's declared audiences, which never include the reserved base. */
  declared: readonly string[];
}

export function resolveSessionAudience(input: SessionAudienceInput): SessionAudience {
  const selected =
    input.session === "managed" && input.requested && input.declared.includes(input.requested)
      ? input.requested
      : null;
  if (input.wrapped) {
    if (selected && selected !== input.wrapped) {
      return { kind: "conflict", wrapped: input.wrapped, requested: selected };
    }
    return { kind: "wrap", audience: input.wrapped };
  }
  return selected ? { kind: "launch", audience: selected } : { kind: "base" };
}

/** Why a managed launch in a checkout wrapped for another audience is refused, and what to do. */
export function describeAudienceConflict(
  conflict: Extract<SessionAudience, { kind: "conflict" }>,
  repository: { id: string; path: string },
): string {
  const { wrapped, requested } = conflict;
  return `${FRAMEWORK_NAME}: ${repository.id} is wrapped for audience "${wrapped}", but MATE_AUDIENCE selects "${requested}". Run \`${FRAMEWORK_NAME} wrap --audience ${requested}\` in ${repository.path}, or launch from another worktree wrapped for "${requested}".`;
}

/** A bare session's audience layer: the newest one of the audience the checkout at `repoRoot` is wrapped for; `null` for none. */
export function wrappedAudienceLayer(companionPath: string, repoRoot: string): string | null {
  const audience = readWrapStateSync(repoRoot).audience;
  return audience ? currentAudienceLayer(companionPath, audience) : null;
}
