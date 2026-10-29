/** mate's compiled rules; test/rule-agreement.test.ts keeps them in step with mate-core. */

export type FixtureRule = {
  pattern: string;
  source: string;
  flags: string;
  subject: "name" | "path";
};

const COMPILED: Record<string, Pick<FixtureRule, "source" | "subject">> = {
  ".env": { source: "^\\.env$", subject: "name" },
  ".env.*": { source: "^\\.env\\.[^/]*$", subject: "name" },
  "*.pem": { source: "^[^/]*\\.pem$", subject: "name" },
  "*.key": { source: "^[^/]*\\.key$", subject: "name" },
  "*.p12": { source: "^[^/]*\\.p12$", subject: "name" },
  "*.pfx": { source: "^[^/]*\\.pfx$", subject: "name" },
  id_rsa: { source: "^id_rsa$", subject: "name" },
  id_ecdsa: { source: "^id_ecdsa$", subject: "name" },
  id_ed25519: { source: "^id_ed25519$", subject: "name" },
  ".netrc": { source: "^\\.netrc$", subject: "name" },
  ".pgpass": { source: "^\\.pgpass$", subject: "name" },
  ".npmrc": { source: "^\\.npmrc$", subject: "name" },
  ".env.example": { source: "^\\.env\\.example$", subject: "name" },
  ".env.sample": { source: "^\\.env\\.sample$", subject: "name" },
  ".env.template": { source: "^\\.env\\.template$", subject: "name" },
  ".env.dist": { source: "^\\.env\\.dist$", subject: "name" },
  "*.tfstate": { source: "^[^/]*\\.tfstate$", subject: "name" },
  "secrets/**": { source: "(?:^|/)secrets/[\\s\\S]*$", subject: "path" },
};

/** Each pattern's rule, as mate compiles it. */
export const RULES: Record<string, FixtureRule> = Object.fromEntries(
  Object.entries(COMPILED).map(([pattern, rule]) => [pattern, { pattern, ...rule, flags: "i" }]),
);

/** mate's default deny and allow patterns, in mate's order. */
export const DEFAULT_DENY = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
  ".pgpass",
  ".npmrc",
];
export const DEFAULT_ALLOW = [".env.example", ".env.sample", ".env.template", ".env.dist"];

export type PolicyOptions = { guardrails?: boolean; deny?: string[]; allow?: string[] };

const rules = (patterns: string[]) => patterns.map((pattern) => RULES[pattern]!);

/** $MATE_POLICY_JSON as mate writes it: the defaults plus a companion's own `deny` and `allow`. */
export function policyJson({
  guardrails = true,
  deny = [],
  allow = [],
}: PolicyOptions = {}): string {
  return JSON.stringify({
    allowedAgents: ["claude"],
    secrets: {
      guardrails,
      deny: rules([...DEFAULT_DENY, ...deny]),
      allow: rules([...DEFAULT_ALLOW, ...allow]),
    },
  });
}

/** What `mate session context --json` prints for a companion at `root`, as mate writes it. */
export function contextReply(root: string, options: PolicyOptions = {}): string {
  return JSON.stringify({
    protocol: 1,
    companionPath: root,
    repositoryPath: "/work/app",
    repositoryId: "app",
    policyJson: policyJson(options),
  });
}
