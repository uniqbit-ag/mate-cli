import fs from "node:fs";
import path from "node:path";

import { gitKeyOf } from "./git-credential-store";

/**
 * How a token reaches Git: an askpass helper that prints it from the child's own environment, so
 * it is never in a URL, an argument, `.git/config` or a file beside a checkout.
 */

/** A placeholder user name that GitHub and GitLab accept together with a personal token. */
export const GIT_USERNAME = "x-access-token";

const ASKPASS_FILE = "git-askpass.sh";
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "$MATE_GIT_ASKPASS_USERNAME" ;;
  *) printf '%s\\n' "$MATE_GIT_ASKPASS_TOKEN" ;;
esac
`;

/** The helper's path in the state directory, written on first use and readable by the Git user. */
function askpassFile(stateDir: string): string {
  const file = path.join(stateDir, ASKPASS_FILE);
  fs.mkdirSync(stateDir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== ASKPASS_SCRIPT) {
    fs.writeFileSync(file, ASKPASS_SCRIPT, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  return file;
}

/** The environment of the one Git command that needs `token`; prompts are off either way. */
export function gitAuthEnv(stateDir: string, token: string | null): Record<string, string> {
  if (token === null) return { GIT_TERMINAL_PROMPT: "0" };
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpassFile(stateDir),
    MATE_GIT_ASKPASS_USERNAME: GIT_USERNAME,
    MATE_GIT_ASKPASS_TOKEN: token,
  };
}

const AUTH_FAILURE =
  /authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or password|http[s]? (basic: )?access denied|returned error: 40[13]|requested url returned error: 40[13]/i;

export function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}

/** The text with every copy of the token replaced. */
export function scrubToken(text: string, token: string | null): string {
  return token ? text.split(token).join("***") : text;
}

/** What a refused clone says: where, and that a token is missing or refused; never a token. */
export function authFailureMessage(url: string): string {
  const key = gitKeyOf(url);
  const where = key ? `${key.host}/${key.org}` : "the remote";
  return `authentication to ${where} failed: no Git token is stored for it, or the stored token was refused`;
}
