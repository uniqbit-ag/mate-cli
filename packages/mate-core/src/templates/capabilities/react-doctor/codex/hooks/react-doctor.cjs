const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  const root = input.cwd || process.env.MATE_REPO_PATH || process.cwd();
  const session = input.session_id || input.sessionId;
  if (!session) return;
  const markerDir = path.join(process.env.TMPDIR || os.tmpdir(), "mate-react-doctor-hooks");
  const marker = path.join(
    markerDir,
    crypto.createHash("sha256").update(`${root}\0${session}`).digest("hex"),
  );
  const event = input.hook_event_name || input.eventName || input.event_name;
  const tool = input.tool_name || input.toolName || input.tool;
  if (event === "PostToolUse") {
    if (!["Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch", "apply_patch"].includes(tool))
      return;
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, "", { mode: 0o600 });
    return;
  }
  if (event !== "Stop" || !fs.existsSync(marker)) return;
  fs.unlinkSync(marker);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.status === 0 && !status.stdout.trim()) return;
  const local = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "react-doctor.cmd" : "react-doctor",
  );
  const executable =
    process.env.MATE_REACT_DOCTOR_BIN_PATH || (fs.existsSync(local) ? local : "react-doctor");
  const result = spawnSync(
    executable,
    [
      "--yes",
      "--verbose",
      "--scope",
      "changed",
      "--base",
      "HEAD",
      "--blocking",
      "warning",
      "--no-score",
      "--max-duration",
      "30",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 0) return;
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (
    !output ||
    /No React dependency found|Could not resolve config|is not a git repository/i.test(output)
  )
    return;
  const message = `React Doctor found issues in the changed files. Review this output and fix the regressions before finishing.\n\n${output}`;
  process.stdout.write(
    JSON.stringify({ continue: false, stopReason: message, systemMessage: message }),
  );
});
