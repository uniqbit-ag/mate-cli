#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installBun() {
  if (process.platform === "darwin") {
    return {
      preview: "brew install oven-sh/bun/bun",
      command: "brew",
      args: ["install", "oven-sh/bun/bun"],
    };
  }
  if (process.platform === "win32") {
    return {
      preview: 'powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"',
      command: "powershell",
      args: ["-ExecutionPolicy", "Bypass", "-c", "irm bun.sh/install.ps1 | iex"],
    };
  }
  return {
    preview: "curl -fsSL https://bun.sh/install | bash",
    command: "sh",
    args: ["-c", "curl -fsSL https://bun.sh/install | bash"],
  };
}

async function confirm(preview) {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`Mate requires Bun. Run:\n  ${preview}\nInstall Bun now? [y/N] `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  if (!hasBun()) {
    const plan = installBun();
    const yes = process.argv.includes("--yes");
    if (!yes && !(await confirm(plan.preview))) {
      process.stderr.write("Bun installation declined. Re-run with `mate install --yes`.\n");
      process.exitCode = 1;
      return;
    }
    const result = spawnSync(plan.command, plan.args, { stdio: "inherit", shell: false });
    if (result.status !== 0) {
      process.stderr.write(`Bun installation failed. Run manually:\n  ${plan.preview}\n`);
      process.exitCode = result.status || 1;
      return;
    }
    if (!hasBun()) {
      process.stderr.write(
        `Bun installation completed but Bun is still unavailable. Run manually:\n  ${plan.preview}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const bunBin = path.join(os.homedir(), ".bun", "bin");
  const env = { ...process.env, PATH: `${bunBin}${path.delimiter}${process.env.PATH || ""}` };
  // Callers like the Obsidian panel pass a control pipe on fd 3 (BA
  // pty-bridge resize channel) and announce it via MATE_PTY_CONTROL_FD;
  // string "inherit" only covers fds 0-2 and would sever it. Forwarding is
  // env-gated because shells often have an unrelated fd 3 open, and passing
  // an unpassable descriptor makes spawnSync fail outright.
  const stdio = ["inherit", "inherit", "inherit"];
  if (env.MATE_PTY_CONTROL_FD === "3") {
    // Consume the marker: nested mate invocations (the bridge re-spawns
    // `mate cap ba <provider>`) have no control pipe of their own and must
    // not attempt the forward.
    delete env.MATE_PTY_CONTROL_FD;
    try {
      fs.fstatSync(3);
      stdio.push(3);
    } catch {}
  }
  const result = spawnSync("bun", [path.join(__dirname, "cli.ts"), ...process.argv.slice(2)], {
    stdio,
    env,
  });
  if (result.error) process.stderr.write(`mate: failed to launch bun: ${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
