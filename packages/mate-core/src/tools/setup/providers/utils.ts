import path from "node:path";

export function getSetupProvidersRoot(): string {
  return process.env.MATE_SETUP_PROVIDERS_ROOT
    ? path.resolve(process.env.MATE_SETUP_PROVIDERS_ROOT)
    : path.join(import.meta.dirname, "../../../templates/providers");
}

export function getSetupRootTemplates(): string {
  return process.env.MATE_SETUP_ROOT_TEMPLATES
    ? path.resolve(process.env.MATE_SETUP_ROOT_TEMPLATES)
    : path.join(import.meta.dirname, "../../../templates/root");
}
