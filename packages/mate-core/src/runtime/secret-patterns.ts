/**
 * The one secret-file pattern set every guardrail layer reads: guidance,
 * projected deny rules, hook and middleware enforcement, indexer exclusion and
 * the publish scan. Keeping it in one module is what stops the layers from
 * disagreeing about what a secret file is.
 */

export const DEFAULT_SECRET_DENY_PATTERNS: readonly string[] = [
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

/** Example files that document which variables exist; they never hold values. */
export const DEFAULT_SECRET_ALLOW_PATTERNS: readonly string[] = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
];

export interface SecretPolicy {
  /** False only when the companion explicitly opts out. */
  guardrails: boolean;
  /** Defaults plus the companion's extra `secrets.deny` patterns. */
  deny: string[];
  /** Defaults plus the companion's extra `secrets.allow` patterns. */
  allow: string[];
}

export const defaultSecretPolicy = (): SecretPolicy => ({
  guardrails: true,
  deny: [...DEFAULT_SECRET_DENY_PATTERNS],
  allow: [...DEFAULT_SECRET_ALLOW_PATTERNS],
});

function patternList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Parses the `secrets` block of `framework.yaml`. Anything that is not an
 * object yields the defaults with guardrails on, and only a literal `false`
 * turns them off: a broken config never disables protection.
 */
export function parseSecretsConfig(value: unknown): SecretPolicy {
  const policy = defaultSecretPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) return policy;
  const block = value as Record<string, unknown>;
  return {
    guardrails: block.guardrails !== false,
    deny: [...policy.deny, ...patternList(block.deny)],
    allow: [...policy.allow, ...patternList(block.allow)],
  };
}

/**
 * One compiled secret pattern, in a form any JavaScript consumer can evaluate:
 * build `new RegExp(source, flags)` and test it against the subject the rule
 * names. mate's own matching evaluates the same rules, so the two never differ.
 */
export interface SecretRule {
  /** The pattern as configured, for messages. */
  pattern: string;
  /** ECMAScript regular expression source. */
  source: string;
  /** Regular expression flags; `i`, since macOS and Windows ignore letter case. */
  flags: string;
  /** `name` tests the file name; `path` tests the `/`-separated path. */
  subject: "name" | "path";
}

/** A secret policy compiled into rules, as the launch policy carries it. */
export interface SecretRules {
  guardrails: boolean;
  deny: SecretRule[];
  allow: SecretRule[];
}

const compiled = new Map<string, { rule: SecretRule; regExp: RegExp }>();

/**
 * The only secret pattern compiler. Gitignore-style subset: `*` and `?` stay
 * inside a segment, `**` crosses them. Letter case is ignored.
 */
function compile(pattern: string): { rule: SecretRule; regExp: RegExp } {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = "";
  const body = pattern.replace(/^\/+/, "");
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "*" && body[i + 1] === "*") {
      // `**/` matches zero or more whole segments; a bare `**` matches anything.
      // `[\s\S]`, not `.`, so a name holding a line break is crossed too.
      if (body[i + 2] === "/") {
        source += "(?:[\\s\\S]*/)?";
        i += 2;
      } else {
        source += "[\\s\\S]*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A slash-free pattern matches the file name; one with a slash matches the
  // trailing segments of the path, since the repository root is not known here.
  const subject = body.includes("/") ? "path" : "name";
  const rule: SecretRule = {
    pattern,
    source: subject === "path" ? `(?:^|/)${source}$` : `^${source}$`,
    flags: "i",
    subject,
  };
  const entry = { rule, regExp: new RegExp(rule.source, rule.flags) };
  compiled.set(pattern, entry);
  return entry;
}

export function secretRule(pattern: string): SecretRule {
  return { ...compile(pattern).rule };
}

export function secretRules(policy: SecretPolicy): SecretRules {
  return {
    guardrails: policy.guardrails,
    deny: policy.deny.map(secretRule),
    allow: policy.allow.map(secretRule),
  };
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function matchesSecretPattern(filePath: string, patterns: readonly string[]): boolean {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    const { rule, regExp } = compile(pattern);
    return regExp.test(rule.subject === "name" ? name : normalized);
  });
}

/** A path is a secret file when it matches a deny pattern and no allow pattern. */
export function isSecretFile(filePath: string, policy: SecretPolicy): boolean {
  return (
    matchesSecretPattern(filePath, policy.deny) && !matchesSecretPattern(filePath, policy.allow)
  );
}

/**
 * Narrower stand-ins for a default deny pattern that also matches an allowed
 * file. Runtime deny rules are evaluated before allow rules, so `.env.*` there
 * would deny `.env.example` too; these cover the common environment files.
 */
const ALLOW_SAFE_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  ".env.*": [".env.local", ".env.development", ".env.production", ".env.test", ".env.*.local"],
};

/**
 * The default deny patterns a runtime's own deny rules may carry: every
 * default that can't match an allow-listed file, with an overlapping pattern
 * replaced by its narrower stand-ins. Extra `secrets.deny` patterns are never
 * projected: once removed from config, nothing would mark their rules as Mate's.
 */
export function projectableSecretDenyPatterns(): string[] {
  const overlapsAllow = (pattern: string) =>
    DEFAULT_SECRET_ALLOW_PATTERNS.some((allowed) => matchesSecretPattern(allowed, [pattern]));
  return DEFAULT_SECRET_DENY_PATTERNS.flatMap((pattern) =>
    overlapsAllow(pattern) ? (ALLOW_SAFE_EXPANSIONS[pattern] ?? []) : [pattern],
  ).filter((pattern) => !overlapsAllow(pattern));
}

/** Ordinary files a broad glob also matches; a glob matching one is not aimed at secrets. */
const ORDINARY_SAMPLES = ["index.ts", "README.md", "config.json"];

/**
 * Whether a search glob is aimed at secret files: it matches a sample name of
 * some deny pattern that the policy still treats as secret, and no ordinary
 * file. `.env*` and `*.key` are; `**\/*` and `*.ts` are not. A heuristic for
 * search tools, which take a glob rather than a path.
 */
export function globTargetsSecretFiles(glob: string, policy: SecretPolicy): boolean {
  const pattern = glob.trim();
  if (!pattern) return false;
  if (ORDINARY_SAMPLES.some((sample) => matchesSecretPattern(sample, [pattern]))) return false;
  return policy.deny.some((deny) => {
    const sample = deny.slice(deny.lastIndexOf("/") + 1).replace(/[*?]+/g, "x");
    return isSecretFile(sample, policy) && matchesSecretPattern(sample, [pattern]);
  });
}
