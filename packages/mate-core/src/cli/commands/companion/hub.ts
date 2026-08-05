import readline from "node:readline/promises";

import {
  addHubMember,
  discoverHubSource,
  initializeCompanionHub,
  syncHub,
  updateHubPlugins,
} from "../../../lib/orchestrator/companion-hub";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";

function positionalArgs(argv: string[]): string[] {
  const values: string[] = [];
  const valueFlags = new Set(["id", "path", "url", "companion", "ref"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      values.push(value);
      continue;
    }
    if (valueFlags.has(value.slice(2))) index += 1;
  }
  return values;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function selectRegisteredCompanion(): Promise<string> {
  const companions = await new GlobalConfigStore().list();
  if (companions.length === 0) throw new Error("No registered companions are available.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hub add requires a source path or Git URL outside a TTY.");
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Registered companions:");
    companions.forEach((candidate, index) => console.log(`  ${index + 1}. ${candidate}`));
    const answer = await prompt.question("Select a companion: ");
    const selected = companions[Number.parseInt(answer, 10) - 1];
    if (!selected) throw new Error("Invalid companion selection.");
    return selected;
  } finally {
    prompt.close();
  }
}

async function runHubInit(argv: string[]): Promise<void> {
  const folder = positionalArgs(argv)[0] ?? process.cwd();
  const hubPath = await initializeCompanionHub(folder);
  await updateHubPlugins(hubPath);
  console.log(`Initialized companion hub: ${hubPath}`);
}

async function runHubAdd(argv: string[]): Promise<void> {
  const sourceArg =
    positionalArgs(argv)[0] ?? flagValue(argv, "url") ?? flagValue(argv, "companion");
  const source = discoverHubSource(sourceArg ?? (await selectRegisteredCompanion()));
  const ref = flagValue(argv, "ref");
  if (ref && source.kind === "git") source.ref = ref;
  const member = await addHubMember(process.cwd(), source, {
    id: flagValue(argv, "id"),
    memberPath: flagValue(argv, "path"),
  });
  console.log(`Added hub member ${member.id}: ${member.path}`);
}

async function runHubSync(argv: string[]): Promise<void> {
  const results = await syncHub(process.cwd());
  const plugins = await updateHubPlugins(process.cwd());
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ companions: results, plugins }));
    return;
  }
  for (const result of results) console.log(`${result.id}: ${result.status} (${result.message})`);
  for (const plugin of plugins) {
    const detail = plugin.status === "failed" ? `: ${plugin.error ?? "failed"}` : "";
    console.log(`hub plugin ${plugin.package}: ${plugin.status}${detail}`);
  }
  if (plugins.some((plugin) => plugin.status === "failed")) process.exitCode = 1;
}

export async function runHubCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "init":
      await runHubInit(rest);
      return;
    case "add":
      await runHubAdd(rest);
      return;
    case "sync":
      await runHubSync(rest);
      return;
    default:
      throw new Error("Usage: mate hub <init|add|sync>");
  }
}
