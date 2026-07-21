import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function getWrapperBinPath(): string {
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}

export function getReactDoctorBinPath(): string {
  try {
    const entryPath = require.resolve("react-doctor");
    return path.resolve(path.dirname(entryPath), "../bin/react-doctor.js");
  } catch {
    return path.resolve(import.meta.dirname, "../../node_modules/.bin/react-doctor");
  }
}
