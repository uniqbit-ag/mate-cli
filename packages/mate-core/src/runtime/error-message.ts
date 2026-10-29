/** The message of a thrown value, whether or not it is an `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
