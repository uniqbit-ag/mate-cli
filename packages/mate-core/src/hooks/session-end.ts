/** Shim entries for the `SessionEnd` and `Notification` hooks: session registry updates only. */
import { isWrapCopy, runEnd, runNotification } from "./session-register";

export function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runEnd(isWrapCopy, argv);
}

export function runAttention(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runNotification(isWrapCopy, argv);
}
