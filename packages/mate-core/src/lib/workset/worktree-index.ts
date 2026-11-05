import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../../runtime/error-message";
import { resolveSecretPolicy } from "../../runtime/policy";
import {
  ensureTokensaveBranchingPosture,
  ensureTokensaveStoreExcluded,
  isTokensaveIndexed,
  TOKENSAVE_STORE_CONFIG_FILE,
  TOKENSAVE_STORE_DIR,
  tokensaveDeps,
} from "../../tools/setup/capabilities/tokensave";

/**
 * A Workset worktree's own tokensave index, seeded when its main checkout has
 * one. Seeded by `tokensave init`, not copied: the store's config pins an
 * absolute `root_dir`.
 */

export interface IndexOutcome {
  outcome: "ok" | "failed" | "skipped";
  reason?: string;
}

export interface TokensaveRunner {
  /** Whether `tokensave` resolves on PATH. */
  available(): boolean;
  /** Runs `tokensave <args>` in `cwd`; resolves to the failure message, or null. */
  run(cwd: string, args: string[]): Promise<string | null>;
}

const MAIN_NOT_INDEXED = "main checkout not indexed";
const TOKENSAVE_NOT_ON_PATH = "tokensave not on PATH";

const STDERR_TAIL = 4096;

const CPU_USAGE_PROFILES = new Set(["low", "balanced", "performance"]);

const runTokensave: TokensaveRunner = {
  available: () => tokensaveDeps.isCommandOnPath("tokensave", tokensaveDeps.pathValue()),
  run: (cwd, args) =>
    new Promise((resolve) => {
      let stderr = "";
      const child = spawn("tokensave", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
      // Only the tail is reported; a full index can write a lot.
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
      });
      child.on("error", (error) => resolve(error.message));
      child.on("close", (code) => {
        const detail = stderr.trim().split("\n").at(-1);
        resolve(
          code === 0 ? null : `tokensave ${args[0]} exited ${code}${detail ? `: ${detail}` : ""}`,
        );
      });
    }),
};

/** The main checkout's stored profile, so `init` skips its resource benchmark. */
async function cpuUsage(checkout: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(
      await fs.readFile(
        path.join(checkout, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE),
        "utf8",
      ),
    ) as { cpu_usage?: unknown };
    const profile = config.cpu_usage;
    return typeof profile === "string" && CPU_USAGE_PROFILES.has(profile) ? profile : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Indexes `worktree` like `checkout`: `init` plus Mate's posture when it has no
 * index yet, `sync` when it has one. `onRun` fires before tokensave starts.
 * Never throws; a failure is an outcome.
 */
export async function indexWorktree(
  checkout: string,
  worktree: string,
  companionPath: string,
  tokensave: TokensaveRunner = runTokensave,
  onRun?: (action: "init" | "sync") => void,
): Promise<IndexOutcome> {
  if (!(await isTokensaveIndexed(checkout)))
    return { outcome: "skipped", reason: MAIN_NOT_INDEXED };
  if (!tokensave.available()) return { outcome: "skipped", reason: TOKENSAVE_NOT_ON_PATH };
  try {
    const posture = () =>
      ensureTokensaveBranchingPosture(worktree, resolveSecretPolicy(companionPath));
    let failure: string | null;
    if (await isTokensaveIndexed(worktree)) {
      await posture();
      onRun?.("sync");
      failure = await tokensave.run(worktree, ["sync"]);
    } else {
      await ensureTokensaveStoreExcluded(worktree);
      const profile = await cpuUsage(checkout);
      onRun?.("init");
      failure = await tokensave.run(worktree, [
        "init",
        worktree,
        "--no-git-hook",
        ...(profile ? ["--cpu-usage", profile] : []),
      ]);
      if (!failure) await posture();
    }
    return failure ? { outcome: "failed", reason: failure } : { outcome: "ok" };
  } catch (error) {
    return { outcome: "failed", reason: errorMessage(error) };
  }
}
