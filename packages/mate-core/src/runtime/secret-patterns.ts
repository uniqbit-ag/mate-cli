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

/** Evaluate as `new RegExp(source, flags)` against `subject`; mate matches with the same rules, so consumers never differ. */
export interface SecretRule {
  /** The pattern as configured, for messages. */
  pattern: string;
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

/** POSIX bracket classes, as gitignore's matcher knows them; letter case is ignored anyway. */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: "a-z0-9",
  alpha: "a-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\s",
  upper: "a-z",
  xdigit: "0-9a-f",
};

const escapeRegExp = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source never matching `/`, and the closing `]` index; null when unclosed, so `[` is literal. */
function bracket(body: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  const negated = body[i] === "!" || body[i] === "^";
  if (negated) i++;
  let members = "";
  for (let first = true; i < body.length; i++, first = false) {
    const char = body[i];
    if (char === "]" && !first) {
      return { source: negated ? `[^/${members}]` : `(?!/)[${members}]`, end: i };
    }
    if (char === "[" && body[i + 1] === ":") {
      const close = body.indexOf(":]", i + 2);
      const named = close === -1 ? undefined : POSIX_CLASSES[body.slice(i + 2, close)];
      if (named === undefined) return null;
      members += named;
      i = close + 1;
    } else if (char === "\\" && i + 1 < body.length) {
      /** An escaped `-` is a member, never a range. */
      const escaped = body[++i];
      members += escaped === "-" ? "\\-" : escapeRegExp(escaped);
    } else {
      members += escapeRegExp(char);
    }
  }
  return null;
}

/**
 * gitignore syntax, case-insensitive. A trailing `/` matches the folder and
 * everything in it; without one only files match. A leading `!` is literal
 * (list allowed files under `allow`).
 */
function compile(pattern: string): { rule: SecretRule; regExp: RegExp } {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = "";
  const folder = /[^/]\/+$/.test(pattern);
  const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    const set = char === "[" ? bracket(body, i) : null;
    if (set) {
      source += set.source;
      i = set.end;
    } else if (char === "*" && body[i + 1] === "*") {
      // `**/` matches zero or more whole segments; a bare `**` matches anything.
      /** `[\s\S]`, not `.`, so a name holding a line break is crossed too. */
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
    } else if (char === "\\" && i + 1 < body.length) {
      source += escapeRegExp(body[++i]);
    } else {
      source += escapeRegExp(char);
    }
  }
  /**
   * A slash-free pattern matches the file name; one with a slash, or naming a folder, matches
   * the trailing segments of the path, since the repository root is not known here.
   */
  const subject = folder || body.includes("/") ? "path" : "name";
  let anchored: string;
  if (body === "") anchored = "(?!)";
  else if (folder) anchored = `(?:^|/)${source}(?:/[\\s\\S]*)?$`;
  else if (subject === "path") anchored = `(?:^|/)${source}$`;
  else anchored = `^${source}$`;
  const rule: SecretRule = { pattern, source: anchored, flags: "i", subject };
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

export interface SecretPathOptions {
  /**
   * Whether `\\` separates folders, as on Windows; elsewhere it is part of a
   * name, so `public\\server.key` is one file, not `public/server.key`.
   * Defaults to the platform Mate runs on.
   */
  windows?: boolean;
}

const IS_WINDOWS = process.platform === "win32";

function normalizePath(filePath: string, { windows = IS_WINDOWS }: SecretPathOptions): string {
  return (windows ? filePath.replaceAll("\\", "/") : filePath).replace(/\/+$/, "");
}

export function matchesSecretPattern(
  filePath: string,
  patterns: readonly string[],
  options: SecretPathOptions = {},
): boolean {
  const normalized = normalizePath(filePath, options);
  if (!normalized) return false;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    const { rule, regExp } = compile(pattern);
    return regExp.test(rule.subject === "name" ? name : normalized);
  });
}

/** A path is a secret file when it matches a deny pattern and no allow pattern. */
export function isSecretFile(
  filePath: string,
  policy: SecretPolicy,
  options: SecretPathOptions = {},
): boolean {
  return (
    matchesSecretPattern(filePath, policy.deny, options) &&
    !matchesSecretPattern(filePath, policy.allow, options)
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

/** Most alternatives a search glob's `{a,b}` groups may expand to; a glob with more is refused unchecked. */
export const BRACE_LIMIT = 64;

const capAlternatives = (count: number) => Math.min(count, BRACE_LIMIT + 1);

/** Glob text, or the branches of one `{a,b}` group. */
type BracePart = string | BraceSequence[];
type BraceSequence = BracePart[];

/**
 * A glob's `{a,b}` groups as ripgrep reads them: a `[...]` set or an escaped
 * character is text, `{a}` is a group too, groups nest, and an unclosed group
 * closes at the end. On Windows ripgrep reads `**\` as `**\/`. Null when groups
 * nest deeper than {@link BRACE_LIMIT}.
 */
function parseBraces(
  glob: string,
  { windows = IS_WINDOWS }: SecretPathOptions,
): BraceSequence | null {
  const source = windows ? glob.replaceAll("**\\", "**/") : glob;
  let i = 0;
  const sequence = (depth: number): BraceSequence | null => {
    const parts: BraceSequence = [];
    while (i < source.length) {
      const char = source[i];
      if (depth > 0 && (char === "," || char === "}")) break;
      if (char === "{") {
        if (depth === BRACE_LIMIT) return null;
        const branches: BraceSequence[] = [];
        do {
          i++;
          const branch = sequence(depth + 1);
          if (!branch) return null;
          branches.push(branch);
        } while (source[i] === ",");
        i++;
        parts.push(branches);
        continue;
      }
      const set = char === "[" ? bracket(source, i) : null;
      const end = set ? set.end + 1 : char === "\\" ? i + 2 : i + 1;
      const last = parts.at(-1);
      if (typeof last === "string") parts[parts.length - 1] = last + source.slice(i, end);
      else parts.push(source.slice(i, end));
      i = end;
    }
    return parts;
  };
  return sequence(0);
}

function alternativeCount(sequence: BraceSequence): number {
  return sequence.reduce<number>((count, part) => {
    if (typeof part === "string") return count;
    const branches = part.reduce(
      (sum, branch) => capAlternatives(sum + alternativeCount(branch)),
      0,
    );
    return capAlternatives(count * branches);
  }, 1);
}

function expandBraces(sequence: BraceSequence): string[] {
  return sequence.reduce<string[]>(
    (prefixes, part) => {
      const options = typeof part === "string" ? [part] : part.flatMap(expandBraces);
      return prefixes.flatMap((prefix) => options.map((option) => prefix + option));
    },
    [""],
  );
}

/**
 * Whether a glob's `{a,b}` groups expand to more than {@link BRACE_LIMIT}
 * alternatives. Counts without expanding, so a long glob can't stall the check.
 */
export function exceedsBraceLimit(glob: string, options: SecretPathOptions = {}): boolean {
  const parsed = parseBraces(glob, options);
  return !parsed || alternativeCount(parsed) > BRACE_LIMIT;
}

/** A file name a glob or pattern matches: each wildcard filled with `x`, a set with its first member. */
function sampleName(glob: string): string {
  let sample = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const set = char === "[" ? bracket(glob, i) : null;
    if (set) {
      const negated = glob[i + 1] === "!" || glob[i + 1] === "^";
      const first = glob[i + (negated ? 2 : 1)];
      sample += negated || first === "[" || first === "\\" ? "x" : first;
      i = set.end;
    } else if (char === "*" || char === "?") {
      while (glob[i + 1] === "*") i++;
      sample += "x";
    } else if (char === "\\" && i + 1 < glob.length) {
      sample += glob[++i];
    } else {
      sample += char;
    }
  }
  return sample;
}

/**
 * Heuristic for search tools. An `{a,b}` alternative is aimed at secrets when
 * it matches no ordinary file and, wildcards filled in, names a secret file or
 * matches a deny pattern's sample name. `**\/*`, `*.ts` and `!` exclusions are not.
 * A glob past {@link BRACE_LIMIT} counts as aimed at secrets.
 */
export function globTargetsSecretFiles(
  glob: string,
  policy: SecretPolicy,
  options: SecretPathOptions = {},
): boolean {
  const pattern = glob.trim();
  if (!pattern || pattern.startsWith("!")) return false;
  const parsed = parseBraces(pattern, options);
  if (!parsed || alternativeCount(parsed) > BRACE_LIMIT) return true;
  return expandBraces(parsed).some((alternative) => {
    if (ORDINARY_SAMPLES.some((sample) => matchesSecretPattern(sample, [alternative]))) {
      return false;
    }
    if (isSecretFile(sampleName(alternative), policy)) return true;
    return policy.deny.some((deny) => {
      const trimmed = deny.replace(/\/+$/, "");
      const sample = sampleName(trimmed.slice(trimmed.lastIndexOf("/") + 1));
      return (
        sample !== "" && isSecretFile(sample, policy) && matchesSecretPattern(sample, [alternative])
      );
    });
  });
}
