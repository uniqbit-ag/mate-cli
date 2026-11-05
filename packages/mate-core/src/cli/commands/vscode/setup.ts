import { spawnSync } from "node:child_process";

import { version as coreVersion } from "../../../../package.json";
import { FRAMEWORK_NAME } from "../../../framework";
import { resolveEditorBinary } from "../../../lib/orchestrator/editor";
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

export interface VscodeSetupDeps {
  resolveEditor: (cli: Editor) => string | null;
  /** Runs `<binary> --install-extension <vsix> --force`; returns the exit status and output. */
  install: (binary: string, vsix: string) => { ok: boolean; output: string };
  /** `<binary> --list-extensions`; null when it cannot be listed. */
  installedExtensions: (binary: string) => string[] | null;
  vsix: VsixResolverDeps;
  version: string;
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
    const result = spawnSync(binary, ["--list-extensions"], { encoding: "utf8", timeout: 30_000 });
    return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()) : null;
  },
  vsix: vsixResolverDeps,
  version: coreVersion,
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
    const editors = found.filter(({ binary }) =>
      deps.installedExtensions(binary)?.some((id) => id.toLowerCase() === EXTENSION_ID),
    );
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
  let vsix: string;
  try {
    vsix = await resolveVsix({ vsix: vsixArg, version: deps.version }, deps.vsix);
  } catch (error) {
    if (error instanceof VsixError) return fail(error.message);
    throw error;
  }

  let installed = 0;
  for (const { editor, binary } of editors) {
    const result = deps.install(binary, vsix);
    if (result.ok) {
      installed += 1;
      console.log(`  ${EDITOR_NAMES[editor]}: installed`);
    } else {
      console.log(`  ${EDITOR_NAMES[editor]}: failed${result.output ? ` — ${result.output}` : ""}`);
    }
  }
  if (installed === 0) return fail("the extension could not be installed into any editor");
  console.log("Reload open editor windows to load the Mate sidebar.");
}

export async function runVscodeCommand(subcommand: string | undefined, rest: string[]) {
  if (subcommand === "setup") {
    await runVscodeSetupCommand(rest);
    return;
  }
  fail(`unknown vscode subcommand: ${subcommand ?? ""}`.trimEnd(), true);
}
