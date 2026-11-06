/** A Delivery Branch template: a fixed prefix ending in `/`, `{workset}`, and optional `{ticket}`. */
export type BranchTemplate = string;

export const DEFAULT_BRANCH_TEMPLATE: BranchTemplate = "workset/{ticket}-{workset}";

const PLACEHOLDER = /\{([^{}]*)\}/g;
const SEPARATORS = new Set(["-", "_", "/"]);
// Any case, as `isJiraKey` accepts it; see `matchBranchTemplate` for an all-lowercase one.
const TICKET_KEY = "[A-Za-z][A-Za-z0-9]+-\\d+";

export interface BranchTemplateSetting {
  template: BranchTemplate;
  /** Set for an invalid value, which counts as the default. */
  diagnostic: string | null;
}

/** True when `name` passes `git check-ref-format --branch`, checked without Git. */
function isBranchName(name: string): boolean {
  if (!name || name === "@" || name.startsWith("-") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  // oxlint-disable-next-line no-control-regex -- control characters are invalid in refs
  if (/[\u0000- \u007f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return name
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The rule a template breaks, or null when it is valid. */
function brokenRule(template: string): string | null {
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  const unknown = names.find((name) => name !== "workset" && name !== "ticket");
  if (unknown !== undefined) {
    return `unknown placeholder {${unknown}}; only {workset} and {ticket} exist`;
  }
  if (names.filter((name) => name === "workset").length !== 1) {
    return "{workset} must appear exactly once";
  }
  if (names.filter((name) => name === "ticket").length > 1) {
    return "{ticket} may appear at most once";
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER, ""))) return "a brace is not part of a placeholder";
  if (!branchTemplatePrefix(template).endsWith("/")) {
    return "a fixed prefix ending in / must precede the first placeholder";
  }
  const samples = [
    applyBranchTemplate(template, "acme-fix"),
    applyBranchTemplate(template, "acme-fix", "ABC-123"),
  ];
  if (!samples.every(isBranchName)) return "it does not yield a valid Git branch name";
  return null;
}

/** A configured template; absent means the default, invalid the default with a diagnostic. */
export function parseBranchTemplate(value: unknown): BranchTemplateSetting {
  if (value === undefined) return { template: DEFAULT_BRANCH_TEMPLATE, diagnostic: null };
  const rule = typeof value === "string" ? brokenRule(value) : "it is not a string";
  if (rule === null) return { template: value as string, diagnostic: null };
  return {
    template: DEFAULT_BRANCH_TEMPLATE,
    diagnostic: `Invalid branchTemplate ${JSON.stringify(value)} on the openspec capability: ${rule}; ${DEFAULT_BRANCH_TEMPLATE} applies.`,
  };
}

/**
 * The branch a template names for a Workset. Without a ticket, `{ticket}` and one adjacent
 * separator go, the following one first: `workset/{ticket}-{workset}` → `workset/<id>`.
 */
export function applyBranchTemplate(
  template: BranchTemplate,
  worksetId: string,
  ticket?: string | null,
): string {
  const shaped = ticket ? template.replace("{ticket}", ticket) : withoutTicket(template);
  return shaped.replace("{workset}", worksetId);
}

/** The template without `{ticket}` and one adjacent separator; the prefix's own `/` stays. */
function withoutTicket(template: BranchTemplate): string {
  const at = template.indexOf("{ticket}");
  if (at < 0) return template;
  const end = at + "{ticket}".length;
  if (SEPARATORS.has(template[end] ?? "")) return template.slice(0, at) + template.slice(end + 1);
  const separatorBefore =
    at > branchTemplatePrefix(template).length && SEPARATORS.has(template[at - 1]!);
  return template.slice(0, separatorBefore ? at - 1 : at) + template.slice(end);
}

/** The fixed text before the first placeholder, e.g. `feature/`; scopes ref listing. */
export function branchTemplatePrefix(template: BranchTemplate): string {
  const at = template.indexOf("{");
  return at < 0 ? template : template.slice(0, at);
}

function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `branch` is the template's branch for the Workset, and with which ticket: null for
 * the name without one, else the key as written.
 */
export function matchBranchTemplate(
  template: BranchTemplate,
  branch: string,
  worksetId: string,
): { ticket: string | null } | null {
  if (branch === applyBranchTemplate(template, worksetId)) return { ticket: null };
  if (!template.includes("{ticket}")) return null;
  const source = template
    .split(/(\{ticket\}|\{workset\})/)
    .map((part) => {
      if (part === "{ticket}") return `(${TICKET_KEY})`;
      return escape(part === "{workset}" ? worksetId : part);
    })
    .join("");
  const ticket = new RegExp(`^${source}$`).exec(branch)?.[1];
  if (!ticket) return null;
  // After {workset}, an all-lowercase key reads as the tail of a longer Workset id: `fix-login-2`.
  const trailing = template.indexOf("{ticket}") > template.indexOf("{workset}");
  return trailing && ticket === ticket.toLowerCase() ? null : { ticket };
}
