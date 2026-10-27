/**
 * The kind of session a prepare or a delivery plan answers for, shared by every
 * Agent Runtime. `managed-repo`: a managed launch with a Working Repository; its
 * prepare just reconciled the wrap, which the launcher asserts.
 * `managed-companion`: a companion-scoped managed launch. `unmanaged`: a
 * session with no launch environment.
 */
export type SessionKind = "managed-repo" | "managed-companion" | "unmanaged";

/** A managed launch's kind: with a Working Repository, or companion-scoped. */
export function managedSessionKind(withRepository: boolean): SessionKind {
  return withRepository ? "managed-repo" : "managed-companion";
}
