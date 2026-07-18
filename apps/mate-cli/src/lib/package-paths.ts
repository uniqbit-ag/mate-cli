import path from "node:path";

export function getWrapperBinPath(): string {
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}
