#!/bin/sh
set -u

input_file=$(mktemp "${TMPDIR:-/tmp}/react-doctor-agent-hook.XXXXXX")
output_file=$(mktemp "${TMPDIR:-/tmp}/react-doctor-agent-hook-output.XXXXXX")
trap 'rm -f "$input_file" "$output_file"' EXIT
cat > "$input_file"

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
project_root=${CLAUDE_PROJECT_DIR:-}
if [ -z "$project_root" ] && command -v node >/dev/null 2>&1; then
  project_root=$(node - "$input_file" <<'NODE'
const fs = require('node:fs');
try {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8') || '{}');
  if (typeof input.cwd === 'string') process.stdout.write(input.cwd);
} catch {
  // Fall back to the current working directory or the hook location below.
}
NODE
)
fi
if [ -z "$project_root" ]; then
  project_root=${PWD:-}
fi
if [ -z "$project_root" ]; then
  project_root=$(CDPATH='' cd "$script_dir/../.." && pwd)
fi
if ! cd "$project_root"; then
  exit 0
fi

should_scan() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  node - "$input_file" "$project_root" <<'NODE'
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inputPath = process.argv[2];
const projectRoot = process.argv[3];
const editToolNames = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);
try {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8') || '{}');
  const eventName = input.hook_event_name || input.eventName || input.event_name;
  const sessionId = input.session_id || input.sessionId;
  if (!sessionId) process.exit(10);

  const markerDir = path.join(process.env.TMPDIR || os.tmpdir(), 'mate-react-doctor-hooks');
  const markerKey = crypto
    .createHash('sha256')
    .update(`${projectRoot}\0${sessionId}`)
    .digest('hex');
  const markerPath = path.join(markerDir, markerKey);

  const hasWorkingTreeChanges = () => {
    const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    // Preserve the existing scan behavior when git is unavailable or the
    // project is not a git repository; React Doctor will handle that case.
    if (result.error || result.status !== 0) return true;
    return Boolean(result.stdout.trim());
  };

  if (eventName === 'PostToolUse') {
    const toolName = input.tool_name || input.toolName || input.tool;
    if (!editToolNames.has(toolName)) process.exit(10);
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, '', { mode: 0o600 });
    process.exit(10);
  }

  if (eventName !== 'Stop' || !fs.existsSync(markerPath)) process.exit(10);
  fs.unlinkSync(markerPath);
  if (!hasWorkingTreeChanges()) process.exit(10);
  process.exit(0);
} catch {
  process.exit(10);
}
NODE
}

REACT_DOCTOR_VERSION=${REACT_DOCTOR_VERSION:-0.8.1}

run_react_doctor() {
  if [ -n "${MATE_REACT_DOCTOR_BIN_PATH:-}" ] && [ -x "$MATE_REACT_DOCTOR_BIN_PATH" ]; then
    "$MATE_REACT_DOCTOR_BIN_PATH" --yes --verbose --scope changed --base HEAD --blocking warning --no-score --max-duration 30
    return
  fi

  if [ -x ./node_modules/.bin/react-doctor ]; then
    ./node_modules/.bin/react-doctor --yes --verbose --scope changed --base HEAD --blocking warning --no-score --max-duration 30
    return
  fi

  if command -v react-doctor >/dev/null 2>&1; then
    react-doctor --yes --verbose --scope changed --base HEAD --blocking warning --no-score --max-duration 30
    return
  fi

  printf '%s\n' "react-doctor: executable unavailable; install react-doctor@${REACT_DOCTOR_VERSION} in Mate or the project, then retry."
  return 127
}

if ! should_scan; then
  exit 0
fi

if run_react_doctor > "$output_file" 2>&1; then
  exit 0
fi

node - "$input_file" "$output_file" <<'NODE'
const fs = require('node:fs');
const outputPath = process.argv[3];
const scanOutput = fs.readFileSync(outputPath, 'utf8').trim();
if (!scanOutput) process.exit(0);

const NON_LINT_FAILURES = [
  /No React dependency found/i,
  /Could not resolve config/i,
  /is not a git repository/i,
];
if (NON_LINT_FAILURES.some((re) => re.test(scanOutput))) process.exit(0);

if (/^react-doctor: executable unavailable/i.test(scanOutput)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `${scanOutput}\nReact Doctor was not run. Install the pinned Mate runtime dependency with \`bun install\` in the Mate checkout, or install \`react-doctor@0.8.1\` in the project root, then retry.`,
    },
  }));
  process.exit(0);
}

const message = `React Doctor found issues in the changed files. Review this output and fix the regressions before finishing. For confirmed issues that cannot be fixed now, create GitHub issues with the rule, file/line, confidence, impact, and proposed fix.\n\n${scanOutput}`;
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: message } }));
NODE
