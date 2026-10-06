/**
 * Root entry for a plugin bound by directory path: OpenCode resolves `<dir>/server`
 * there and never reads `exports`, which serves only package-name references.
 */
export { default } from "./src/server";
