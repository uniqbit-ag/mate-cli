export const frameworkConfig = {
  name: "mate",
  // When renaming, move the old name here so dirs get migrated automatically.
  legacyNames: ["kizuna", "axon"] as string[],
  runtime: "bun",
  supportedAdapters: ["claude", "codex", "opencode"],
};
