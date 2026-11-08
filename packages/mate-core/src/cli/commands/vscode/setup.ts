import { spawnSync } from "node:child_process";

import { version as coreVersion } from "../../../../package.json";
import { FRAMEWORK_NAME } from "../../../framework";
import { resolveEditorBinary } from "../../../lib/orchestrator/editor";
import releaseVsix from "./release-vsix.json";
import { resolveVsix, VsixError, vsixResolverDeps, type VsixResolverDeps } from "./vsix";

const EDITORS = ["code", "cursor"] as const;
type Editor = (typeof EDITORS)[number];

const EDITOR_NAMES: Record<Editor, string> = { code: "VS Code", cursor: "Cursor" };

/** The id the editors list the installed extension under (`publisher.name` of the VSIX manifest). */
const EXTENSION_ID = "uniqbit.mate";

const USAGE = `Usage: ${FRAMEWORK_NAME} vscode setup [--editor code|cursor] [--vsix <path>] [--if-installed]`;

interface VscodeSetupArgs {
  editor?: Editor;
  vsix?: string;
  /** Only editors that already have the extension; none is no error. */
  ifInstalled?: boolean;
}

function parseVscodeSetupArgs(argv: string[]): VscodeSetupArgs | { error: string } {
  const args: VscodeSetupArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    if (arg === "--if-installed") {
      args.ifInstalled = true;
    } else if (flag === "--editor" || flag === "--vsix") {
      const value = inline ?? argv[++index];
      if (!value) return { error: `${flag} requires a value` };
      if (flag === "--vsix") {
        args.vsix = value;
      } else if ((EDITORS as readonly string[]).includes(value)) {
        args.editor = value as Editor;
      } else {
        return { error: `unknown editor: ${value} (expected ${EDITORS.join(" or ")})` };
      }
    } else {
      return { error: `unknown vscode setup option: ${arg}` };
    }
  }
  return args;
}

/** One `--list-extensions --show-versions` entry; `version` is absent when the line has none. */
export interface InstalledExtension {
  id: string;
  version?: string;
}

/** Splits `publisher.name@1.2.3` on the last `@`. */
function parseExtensionLine(line: string): InstalledExtension {
  const at = line.lastIndexOf("@");
  return at > 0 ? { id: line.slice(0, at), version: line.slice(at + 1) } : { id: line };
}

function findMate(extensions: InstalledExtension[] | null): InstalledExtension | undefined {
  return extensions?.find(({ id }) => id.toLowerCase() === EXTENSION_ID);
}

export interface VscodeSetupDeps {
  resolveEditor: (cli: Editor) => string | null;
  /** Runs `<binary> --install-extension <vsix> --force`; returns the exit status and output. */
  install: (binary: string, vsix: string) => { ok: boolean; output: string };
  /** `<binary> --list-extensions --show-versions`; null when it cannot be listed. */
  installedExtensions: (binary: string) => InstalledExtension[] | null;
  vsix: VsixResolverDeps;
  version: string;
  /** Written at release preparation; applies only when it names `version`. */
  releaseVsix: { version: string | null; sha512: string | null };
}

export const vscodeSetupDeps: VscodeSetupDeps = {
  resolveEditor: resolveEditorBinary,
  install: (binary, vsix) => {
    const result = spawnSync(binary, ["--install-extension", vsix, "--force"], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
    return { ok: result.status === 0, output: output.trim() };
  },
  installedExtensions: (binary) => {
    const result = spawnSync(binary, ["--list-extensions", "--show-versions"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) return null;
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseExtensionLine);
  },
  vsix: vsixResolverDeps,
  version: coreVersion,
  releaseVsix,
};

function fail(message: string, usage = false): void {
  console.error(`${FRAMEWORK_NAME}: ${message}`);
  if (usage) console.error(USAGE);
  process.exitCode = 1;
}

/**
 * `mate vscode setup`: installs the Mate extension into every resolved VS Code
 * and Cursor CLI; with `--if-installed`, only into those that already have it
 * (how `mate update` brings the extension to the new version).
 */
export async function runVscodeSetupCommand(
  argv: string[],
  deps: VscodeSetupDeps = vscodeSetupDeps,
): Promise<void> {
  const parsed = parseVscodeSetupArgs(argv);
  if ("error" in parsed) return fail(parsed.error, true);

  const resolved = (parsed.editor ? [parsed.editor] : [...EDITORS]).map((editor) => ({
    editor,
    binary: deps.resolveEditor(editor),
  }));
  const found = resolved.filter(
    (entry): entry is { editor: Editor; binary: string } => entry.binary !== null,
  );
  if (parsed.ifInstalled) {
    const editors = found.filter(({ binary }) => findMate(deps.installedExtensions(binary)));
    if (editors.length === 0) return;
    return installInto(editors, parsed.vsix, deps);
  }
  if (found.length === 0) {
    const wanted = parsed.editor ? `\`${parsed.editor}\`` : "`code` or `cursor`";
    return fail(
      `no editor CLI found: ${wanted} is not on PATH. In the editor, run "Shell Command: Install '${parsed.editor ?? "code"}' command in PATH", then retry.`,
    );
  }

  for (const { editor, binary } of resolved) {
    if (binary === null)
      console.log(`  ${EDITOR_NAMES[editor]}: not found (\`${editor}\` is not on PATH)`);
  }
  return installInto(found, parsed.vsix, deps);
}

async function installInto(
  editors: Array<{ editor: Editor; binary: string }>,
  vsixArg: string | undefined,
  deps: VscodeSetupDeps,
): Promise<void> {
  const expectedDigest = deps.releaseVsix.version === deps.version ? deps.releaseVsix.sha512 : null;
  let vsix: string;
  try {
    vsix = await resolveVsix({ vsix: vsixArg, version: deps.version, expectedDigest }, deps.vsix);
    if (!expectedDigest && !vsixArg) {
      console.error(
        `VSIX not verified: this Mate build has no release digest for ${deps.version}.`,
      );
    }
  } catch (error) {
    if (error instanceof VsixError) return fail(error.message);
    throw error;
  }

  const installed: Array<{ name: string; version: string }> = [];
  // A failure before any success announces the next success, so all failing prints no "Continuing".
  let continuePending = false;
  for (const { editor, binary } of editors) {
    const name = EDITOR_NAMES[editor];
    const result = deps.install(binary, vsix);
    if (result.ok) {
      const version = findMate(deps.installedExtensions(binary))?.version ?? deps.version;
      if (continuePending) {
        console.log(`  Continuing with ${name}.`);
        continuePending = false;
      }
      installed.push({ name, version });
      console.log(`  ${name}: installed v${version}`);
    } else {
      console.log(`  ${name}: failed${result.output ? ` — ${result.output}` : ""}`);
      if (installed.length > 0) {
        console.log(`  Continuing with ${joinNames(installed.map((entry) => entry.name))}.`);
      } else {
        continuePending = true;
      }
    }
  }
  if (installed.length === 0) return fail("the extension could not be installed into any editor");
  console.log(closingLine(installed));
  console.log("Reload open editor windows to load the Mate sidebar.");
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function closingLine(installed: Array<{ name: string; version: string }>): string {
  const versions = new Set(installed.map((entry) => entry.version));
  if (versions.size === 1) {
    return `Mate extension v${installed[0]!.version} installed in ${joinNames(installed.map((entry) => entry.name))}.`;
  }
  return `Mate extension installed in ${joinNames(installed.map((entry) => `${entry.name} (v${entry.version})`))}.`;
}

export async function runVscodeCommand(subcommand: string | undefined, rest: string[]) {
  if (subcommand === "setup") {
    await runVscodeSetupCommand(rest);
    return;
  }
  fail(`unknown vscode subcommand: ${subcommand ?? ""}`.trimEnd(), true);
}
