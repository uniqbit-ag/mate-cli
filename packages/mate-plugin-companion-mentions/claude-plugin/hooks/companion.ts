// Pure helpers for `@mate:` mentions: no `$`, so tests import them directly.

export const PREFIX = "mate:";

/** One file or folder of the companion repo, relative to its root and `/`-separated; a folder's ends in `/`. */
export type Entry = { rel: string; isDir: boolean };

/** The search an `@` token asks for: `@tasks` and `@mate:tasks` both search for `tasks`. */
export type Query = { query: string; isExplicit: boolean };

/** A folder's direct child, for a folder mention's listing. */
export type Child = { name: string; isDir: boolean };

/**
 * The folders mate syncs into every companion (mate-cli's `MANAGED_ROOTS`):
 * searched only for a query starting with `.`, and listed last.
 */
const MANAGED = [".mate/", ".opencode/", ".claude/", ".agents/", ".graphify/"];

const DRIVE = /^[a-zA-Z]:/;

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

type SecretRule = { pattern: string; regExp: RegExp; subject: "name" | "path" };

/** The companion's secret policy, as mate hands it over in its policy document. */
export type SecretPolicy = {
  guardrails: boolean;
  deny: readonly SecretRule[];
  allow: readonly SecretRule[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flags that keep no state from one match to the next, unlike `g` and `y`. */
const STATELESS_FLAGS = /^[imsuv]*$/;

/** A `deny` or `allow` list of mate's compiled rules, or why it is unusable. */
function rulesOf(value: unknown, list: "deny" | "allow", subject: string): SecretRule[] | string {
  if (!Array.isArray(value)) return `${subject}'s secret policy has no ${list} list`;
  const rules: SecretRule[] = [];
  for (const rule of value) {
    if (
      !isRecord(rule) ||
      typeof rule.pattern !== "string" ||
      typeof rule.source !== "string" ||
      typeof rule.flags !== "string" ||
      !STATELESS_FLAGS.test(rule.flags) ||
      (rule.subject !== "name" && rule.subject !== "path")
    ) {
      return `${subject} holds a malformed ${list} rule`;
    }
    try {
      rules.push({
        pattern: rule.pattern,
        regExp: new RegExp(rule.source, rule.flags),
        subject: rule.subject,
      });
    } catch {
      return `${subject}'s ${list} rule for \`${rule.pattern}\` does not compile`;
    }
  }
  return rules;
}

/**
 * mate compiles the rules; this only evaluates them. `subject` names the
 * document's source, for errors.
 */
export function parsePolicy(
  json: string | undefined,
  subject = "$MATE_POLICY_JSON",
): { policy: SecretPolicy } | { error: string } {
  if (!json) return { error: `${subject} is not set` };
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    return { error: `${subject} is not JSON` };
  }
  const secrets = isRecord(document) ? document.secrets : undefined;
  if (!isRecord(secrets)) return { error: `${subject} holds no secret policy` };
  if (typeof secrets.guardrails !== "boolean") {
    return { error: `${subject}'s secret policy has no guardrails setting` };
  }
  const deny = rulesOf(secrets.deny, "deny", subject);
  if (typeof deny === "string") return { error: deny };
  const allow = rulesOf(secrets.allow, "allow", subject);
  if (typeof allow === "string") return { error: allow };
  return { policy: { guardrails: secrets.guardrails, deny, allow } };
}

const CONTEXT_PROTOCOL = 1;

/** Why a session has no companion, after "was not attached: ". */
export const NO_COMPANION =
  "this session has no mate companion. `mate doctor` shows how this repository is linked";

/** What every reason that leaves the secret policy unknown ends with. */
export const UPDATE_MATE =
  "so mate's secret policy is unknown. A mate version that matches the mate-companion-mentions plugin fixes this";

/** A session's companion and its secret policy, always from one source. */
export type SessionContext = { root: string; policyJson: string; policy: SecretPolicy };

/** Why a session has no usable context, worded to follow "was not attached: ". */
export type ContextFailure = { reason: string };

/**
 * Not `PATH`, so a GUI-started Claude finds it and a repository cannot put
 * another `mate` first.
 */
export function launcherPath(home: string): string {
  return DRIVE.test(home)
    ? `${home.replace(/[\\/]+$/, "")}\\.mate\\runtime\\bin\\mate.cmd`
    : joinPath(home, ".mate/runtime/bin/mate");
}

/**
 * The launcher runs from its own folder: Bun reads `bunfig.toml` from its
 * working directory, so a cloned repository's `preload` could forge its answer.
 */
export function launcherFolder(home: string): string {
  const launcher = launcherPath(home);
  return launcher.slice(0, Math.max(launcher.lastIndexOf("/"), launcher.lastIndexOf("\\")));
}

/**
 * Reads `mate session context --json`. Anything but protocol 1 with an
 * absolute companion and a parsable policy fails closed. A mate without the
 * command prints no JSON.
 */
export function parseContext(stdout: string): SessionContext | ContextFailure {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout.trim());
  } catch {
    return { reason: `the installed mate has no \`session context\` command, ${UPDATE_MATE}` };
  }
  if (!isRecord(reply)) {
    return { reason: `\`mate session context\` printed no reply object, ${UPDATE_MATE}` };
  }
  if (reply.protocol !== CONTEXT_PROTOCOL) {
    return {
      reason: `\`mate session context\` answered protocol ${JSON.stringify(reply.protocol)}, which this plugin does not know, ${UPDATE_MATE}`,
    };
  }
  if (isRecord(reply.error)) {
    const { code, message } = reply.error;
    if (code === "not-wrapped" || code === "companion-missing") return { reason: NO_COMPANION };
    const detail = typeof message === "string" ? `: ${message.replace(/\.$/, "")}` : "";
    return {
      reason:
        code === "companion-not-registered" || code === "repository-not-linked"
          ? `mate refused the companion (${code}${detail})`
          : `\`mate session context\` failed (${String(code)}${detail})`,
    };
  }
  const root = reply.companionPath;
  if (typeof root !== "string" || !isAbsolute(root)) {
    return { reason: `\`mate session context\` named no absolute companion path, ${UPDATE_MATE}` };
  }
  const policyJson = typeof reply.policyJson === "string" ? reply.policyJson : undefined;
  const parsed = parsePolicy(policyJson, "`mate session context`'s policyJson");
  if ("error" in parsed) return { reason: `${parsed.error}, ${UPDATE_MATE}` };
  return { root, policyJson: policyJson!, policy: parsed.policy };
}

/**
 * The deny pattern a companion-relative path matches (`.env.*`) when no allow
 * rule does, or undefined; always undefined with guardrails off. `rel` is
 * `/`-separated, as {@link relativeInside} and git give it, so a `\` in it is
 * part of a name, as mate reads it outside Windows; trailing slashes are trimmed.
 */
export function secretMatch(policy: SecretPolicy, rel: string): string | undefined {
  if (!policy.guardrails) return undefined;
  const path = rel.replace(/\/+$/, "");
  if (path === "") return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const matches = (rule: SecretRule) => rule.regExp.test(rule.subject === "name" ? name : path);
  if (policy.allow.some(matches)) return undefined;
  return policy.deny.find(matches)?.pattern;
}

/**
 * What taking a row writes, or undefined when no mention can name the entry.
 *
 * `@mate:<rel>`, or `@"mate:<rel>"` when the path holds whitespace or ends in
 * a character the engine trims off an unquoted mention (anything but an ASCII
 * letter, digit or `_`). A file ends the token with a space; an unquoted
 * folder leaves it open, so what it holds lists next. The engine ends a
 * mention's path at `#` (`#L10-20` names lines) and a quoted one at `"`, and
 * `\` reads as a separator, so paths holding those are left out. So is a path
 * that starts like a drive (`c:notes.md`), which a mention refuses as absolute.
 */
export function rowText(entry: Entry): string | undefined {
  if (/[#\\]/.test(entry.rel) || DRIVE.test(entry.rel)) return undefined;
  const path = entry.isDir ? entry.rel.slice(0, -1) : entry.rel;
  if (!/\s/.test(path) && /[0-9A-Za-z_]$/.test(path))
    return `@${PREFIX}${entry.rel}${entry.isDir ? "" : " "}`;
  return entry.rel.includes('"') ? undefined : `@"${PREFIX}${entry.rel}" `;
}

/**
 * Every file of a `/`-separated list plus its parent folders, each once,
 * leaving out the policy's secret files and what no mention can name. A listed
 * path ending in `/` is a folder: git lists a nested repository that way.
 */
export function toEntries(files: readonly string[], policy: SecretPolicy): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const add = (entry: Entry) => {
    if (seen.has(entry.rel)) return;
    seen.add(entry.rel);
    if (rowText(entry) !== undefined) entries.push(entry);
  };
  for (const file of files) {
    const rel = file.replace(/^(\.\/)+/, "");
    const isDir = rel.endsWith("/");
    if (rel === "" || rowText({ rel, isDir }) === undefined) continue;
    if (!isDir && secretMatch(policy, rel) !== undefined) continue;
    let dir = "";
    for (const part of rel.split("/").slice(0, -1)) {
      dir += `${part}/`;
      add({ rel: dir, isDir: true });
    }
    if (!isDir) add({ rel, isDir });
  }
  return entries;
}

/** The query an `@` token asks for, or undefined when the token is not one (`#123`, `@"quoted`). */
export function queryOf(token: string): Query | undefined {
  if (!token.startsWith("@") || token.startsWith('@"')) return undefined;
  const rest = token.slice(1);
  return rest.toLowerCase().startsWith(PREFIX)
    ? { query: rest.slice(PREFIX.length), isExplicit: true }
    : { query: rest, isExplicit: false };
}

function isManaged(rel: string): boolean {
  return MANAGED.some((root) => rel.startsWith(root));
}

/** Case-blind order, then exact order, so equal names in different case stay put. */
function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function isSubsequence(text: string, query: string): boolean {
  let at = 0;
  for (const ch of query) {
    at = text.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

/** How well a path matches a lowercase query, lower being better; -1 is no match. */
function score(rel: string, query: string): number {
  const path = rel.toLowerCase();
  const base = baseName(path);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  if (path.includes(query)) return 3;
  if (isSubsequence(path, query)) return 4;
  return -1;
}

function search(pool: readonly Entry[], query: string, limit: number): Entry[] {
  const scored: { entry: Entry; score: number }[] = [];
  for (const entry of pool) {
    const s = score(entry.rel, query);
    if (s >= 0) scored.push({ entry, score: s });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.entry.isDir) - Number(a.entry.isDir) ||
      a.entry.rel.length - b.entry.rel.length ||
      compareText(a.entry.rel, b.entry.rel),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/** What is directly in `folder` (from `inside`, its whole tree) whose name holds `rest`. */
function childrenOf(inside: readonly Entry[], folder: string, rest: string): Entry[] {
  const found: { entry: Entry; tier: number }[] = [];
  for (const entry of inside) {
    const name = entry.rel.toLowerCase().slice(folder.length).replace(/\/$/, "");
    if (name.includes("/")) continue;
    const tier = name === rest ? 0 : name.startsWith(rest) ? 1 : name.includes(rest) ? 2 : -1;
    if (tier !== -1) found.push({ entry, tier });
  }
  found.sort(
    (a, b) =>
      Number(isManaged(a.entry.rel)) - Number(isManaged(b.entry.rel)) ||
      a.tier - b.tier ||
      Number(b.entry.isDir) - Number(a.entry.isDir) ||
      compareText(a.entry.rel, b.entry.rel),
  );
  return found.map((f) => f.entry);
}

/**
 * The entries to offer for a query, best first, at most `limit`. An `@mate:`
 * query naming a folder (`openspec/ch`) lists its direct children, falling back
 * to its whole tree; a bare `@` matches names only, since the engine's own rows
 * lead.
 */
export function rank(
  entries: readonly Entry[],
  { query, isExplicit }: Query,
  limit: number,
): Entry[] {
  const q = query.toLowerCase();
  const unmanaged = () => entries.filter((entry) => !isManaged(entry.rel));
  if (!isExplicit) {
    if (q === "") return [];
    return search(
      unmanaged().filter((entry) => baseName(entry.rel.toLowerCase()).includes(q)),
      q,
      limit,
    );
  }

  const slash = q.lastIndexOf("/");
  const folder = q.slice(0, slash + 1);
  const rest = q.slice(slash + 1);
  const isFolder =
    folder === ""
      ? rest === ""
      : entries.some((entry) => entry.isDir && entry.rel.toLowerCase() === folder);
  if (!isFolder) return search(q.startsWith(".") ? entries : unmanaged(), q, limit);

  const inside = entries.filter((entry) => {
    const rel = entry.rel.toLowerCase();
    return rel.startsWith(folder) && rel !== folder;
  });
  const children = childrenOf(inside, folder, rest);
  return children.length > 0 || rest === ""
    ? children.slice(0, limit)
    : search(inside, rest, limit);
}

/**
 * What a `mate:` mention names: a path inside the companion (`''` for its
 * root), or why it names none; undefined for any other mention. The engine
 * reads `#` as the start of a line range (`#L10-20`), so the path ends there.
 */
export function parseMention(mention: string): { rel: string } | { refused: string } | undefined {
  if (!mention.toLowerCase().startsWith(PREFIX)) return undefined;
  const path = mention.slice(PREFIX.length).replace(/#.*$/, "").replaceAll("\\", "/");
  if (DRIVE.test(path) || path.startsWith("//")) {
    return {
      refused: "it is an absolute path, and a mate: path is relative to the companion repo",
    };
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return { refused: "its `..` would leave the companion repo" };
  return { rel: parts.join("/") };
}

/** Whether a path is absolute: `/x`, `\x`, `C:\x` or `C:/x`. */
export function isAbsolute(path: string): boolean {
  return /^([\\/]|[a-zA-Z]:[\\/])/.test(path);
}

/** `root` and `rel` joined with `/` (Windows accepts it too); `root` itself for an empty `rel`. */
export function joinPath(root: string, rel: string): string {
  return rel === "" ? root : root.replace(/[\\/]+$/, "") + "/" + rel;
}

/** A drive (`C:\x`) or share (`\\server\x`) path, where `\` separates folders. */
function isWindowsPath(path: string): boolean {
  return DRIVE.test(path) || path.startsWith("\\\\");
}

/** `\` as `/` when `windows` (elsewhere it is part of a name), trailing slashes trimmed. */
function slashed(path: string, windows: boolean): string {
  return (windows ? path.replaceAll("\\", "/") : path).replace(/\/+$/, "");
}

/** How a path compares: Windows-style paths (`C:/x`, or the drive `C:` itself) ignore letter case. */
function compareKey(path: string): string {
  return /^[a-zA-Z]:(\/|$)/.test(path) ? path.toLowerCase() : path;
}

/**
 * `path` relative to `root`, `/`-separated (`''` for `root` itself), or
 * undefined when it is outside `root`. `\` separates folders only under a
 * Windows `root`.
 */
export function relativeInside(path: string, root: string): string | undefined {
  const windows = isWindowsPath(root);
  const p = slashed(path, windows);
  const r = slashed(root, windows);
  if (compareKey(p) === compareKey(r)) return "";
  return compareKey(p).startsWith(`${compareKey(r)}/`) ? p.slice(r.length + 1) : undefined;
}

export function isInside(path: string, root: string): boolean {
  return relativeInside(path, root) !== undefined;
}

/**
 * What Claude reads for a folder mention: where the folder is and what it
 * holds, folders first (ending in `/`), at most `limit` names.
 */
export function folderNote(
  shown: string,
  path: string,
  children: readonly Child[],
  limit: number,
): string {
  const head = `${shown} is the folder ${path} in the mate companion repo`;
  if (children.length === 0) return `${head}. It is empty.`;
  const names = children
    .toSorted((a, b) => Number(b.isDir) - Number(a.isDir) || compareText(a.name, b.name))
    .map((child) => (child.isDir ? `${child.name}/` : child.name));
  const lines = names.slice(0, limit).map((name) => `- ${name}`);
  if (names.length > limit) lines.push(`- ... and ${names.length - limit} more`);
  return `${head}. It holds:\n${lines.join("\n")}`;
}
