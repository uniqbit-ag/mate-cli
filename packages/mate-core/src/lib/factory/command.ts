import { spawn } from "node:child_process";

/** The process layer the Workset runtime runs `docker` and `git` through, replaced by a fake in tests. */

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Added to the inherited environment for this command only; never part of argv. */
  env?: Record<string, string>;
  /** Run as this user (by name) through `setpriv`, with that user's home. */
  asUser?: string;
  /** Written to the command's standard input, which is then closed. */
  stdin?: Uint8Array;
  cwd?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) => {
  const argv = options.asUser
    ? [
        "--reuid",
        options.asUser,
        "--regid",
        options.asUser,
        "--init-groups",
        "--",
        command,
        ...args,
      ]
    : args;
  const env = {
    ...process.env,
    ...(options.asUser ? { HOME: `/home/${options.asUser}`, USER: options.asUser } : {}),
    ...options.env,
  };
  return new Promise((resolve) => {
    const child = spawn(options.asUser ? "setpriv" : command, argv, {
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (options.stdin) child.stdin?.end(options.stdin);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) =>
      resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
};
