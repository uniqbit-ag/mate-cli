import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_CREDENTIAL_NAMES, type AgentCredentialName } from "../../../lib/factory/broker";

/**
 * `mate factory setup`: stores the one Claude Code credential the factory's Workset
 * agents use, asked interactively and never echoed, in a file only the user can read.
 * The factory appliance loads it; the user's own `claude` never sees it, because it
 * is not in their shell environment.
 */

export function factoryCredentialFile(home: string = os.homedir()): string {
  return path.join(home, ".mate", "factory", "credential.env");
}

/** Both credentials are about 100 characters; a much shorter one is usually a paste cut at a line break. */
const MIN_LENGTH = 80;

const KINDS: Record<"1" | "2", { name: AgentCredentialName; label: string; prefix: string }> = {
  "1": {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude subscription token (from `claude setup-token`)",
    prefix: "sk-ant-oat",
  },
  "2": { name: "ANTHROPIC_API_KEY", label: "Anthropic API key", prefix: "sk-ant-api" },
};

export interface SetupIo {
  isTTY: boolean;
  /** Reads one line, echoed. */
  ask(question: string): Promise<string>;
  /** Reads one line without echoing it. */
  askHidden(question: string): Promise<string>;
  write(text: string): void;
}

/** Reads the stored credential, or null when none is stored or the file is unusable. */
export async function readFactoryCredential(
  file: string = factoryCredentialFile(),
): Promise<{ name: AgentCredentialName; value: string } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator) as AgentCredentialName;
    if (separator > 0 && AGENT_CREDENTIAL_NAMES.includes(name)) {
      const value = line.slice(separator + 1).trim();
      if (value) return { name, value };
    }
  }
  return null;
}

export async function runFactorySetup(
  io: SetupIo,
  file: string = factoryCredentialFile(),
): Promise<number> {
  if (!io.isTTY) {
    io.write("mate factory setup: needs an interactive terminal to ask for the credential.\n");
    return 1;
  }
  io.write(
    [
      "Which credential should the factory's Workset agents use?",
      `  1) ${KINDS["1"].label}`,
      `  2) ${KINDS["2"].label}`,
      "",
    ].join("\n"),
  );
  const choice = (await io.ask("Choose 1 or 2: ")).trim();
  const kind = KINDS[choice as "1" | "2"];
  if (!kind) {
    io.write("mate factory setup: choose 1 or 2; nothing was stored.\n");
    return 1;
  }
  if (kind.name === "CLAUDE_CODE_OAUTH_TOKEN") {
    io.write("Run `claude setup-token` in another terminal if you have no token yet.\n");
  }
  const value = (await io.askHidden(`${kind.label} (input hidden): `)).trim();
  if (!value) {
    io.write("mate factory setup: nothing was entered; nothing was stored.\n");
    return 1;
  }
  if (/\s/.test(value)) {
    io.write("mate factory setup: the value contains whitespace; nothing was stored.\n");
    return 1;
  }
  const doubt = !value.startsWith(kind.prefix)
    ? `That does not look like a ${kind.label}.`
    : value.length < MIN_LENGTH
      ? `That is only ${value.length} characters; a ${kind.label} is longer, so the paste may have been cut at a line break.`
      : null;
  if (doubt !== null) {
    const confirmed = (await io.ask(`${doubt} Store it anyway? [y/N] `)).trim().toLowerCase();
    if (confirmed !== "y" && confirmed !== "yes") {
      io.write("mate factory setup: nothing was stored.\n");
      return 1;
    }
  }

  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${kind.name}=${value}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
  io.write(
    [
      `Stored the ${kind.label} as ${kind.name} in ${file} (readable by you only).`,
      "The factory appliance loads it: `bun run appliance:local -- --factory` does so by itself,",
      `and a compose service can use \`env_file: ${file}\`. Your own \`claude\` does not see it.`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** The terminal's prompts; hidden input switches off echo while reading. */
export function terminalIo(): SetupIo {
  const stdin = process.stdin;
  const readLine = (hidden: boolean) =>
    new Promise<string>((resolve) => {
      let line = "";
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const [index, char] of [...text].entries()) {
          if (char === "\r" || char === "\n") {
            // A line break with more text after it in the same chunk is a wrapped paste, not Enter.
            if ([...text].slice(index + 1).some((next) => next !== "\r" && next !== "\n")) continue;
            stdin.removeListener("data", onData);
            stdin.setRawMode?.(wasRaw);
            stdin.pause();
            process.stdout.write("\n");
            resolve(line);
            return;
          }
          if (char === "\u0003") {
            stdin.setRawMode?.(wasRaw);
            process.stdout.write("\n");
            process.exit(130);
          }
          if (char === "\u007f") {
            if (line.length > 0 && !hidden) process.stdout.write("\b \b");
            line = line.slice(0, -1);
            continue;
          }
          line += char;
          if (!hidden) process.stdout.write(char);
        }
      };
      stdin.on("data", onData);
    });
  return {
    isTTY: Boolean(stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      process.stdout.write(question);
      return readLine(false);
    },
    askHidden: async (question) => {
      process.stdout.write(question);
      return readLine(true);
    },
    write: (text) => void process.stdout.write(text),
  };
}
