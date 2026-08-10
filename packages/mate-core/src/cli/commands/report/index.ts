import { readFile } from "node:fs/promises";

import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";
import {
  collectCcusageSpending,
  collectRTKSavings,
  collectTokenSaveSavings,
  mergeResults,
} from "./collector";
import type { CollectorDeps } from "./collector";
import { reportDataToDocument } from "./adapter";
import { parseReportDocument, type ReportValidationError } from "./contract";
import { openReportInBrowser, writeTemporaryReport } from "./delivery";
import { renderHTML, renderJSON } from "./renderer";
import type { ReportData, ReportDocument, ReportOptions } from "./types";

interface ReportCommandDeps extends CollectorDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveFrameworkContext?: typeof resolveFrameworkContext;
  writeTemporaryReport?: typeof writeTemporaryReport;
  openReportInBrowser?: typeof openReportInBrowser;
  readInput?: (input: string) => Promise<string>;
}

function parseOptions(argv: string[]): ReportOptions {
  let days = 7;
  let json = false;
  let input: string | undefined;
  let daysSpecified = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      daysSpecified = true;
      const value = argv[i + 1];
      if (!value) throw new Error("--days requires a positive integer");
      days = Number.parseInt(value, 10);
      if (!Number.isInteger(days) || days < 1) {
        throw new Error("--days requires a positive integer");
      }
      i++;
      continue;
    }
    if (argv[i] === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("--input requires a JSON file path or - for stdin");
      if (input !== undefined) throw new Error("--input may only be provided once");
      input = value;
      i++;
      continue;
    }
    if (argv[i] === "--json") json = true;
  }

  if (input !== undefined && daysSpecified) {
    throw new Error("--days cannot be combined with --input; the document supplies its own period");
  }
  return { days, json, input };
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

async function readStructuredInput(input: string, deps: ReportCommandDeps): Promise<string> {
  if (deps.readInput) return deps.readInput(input);
  return input === "-" ? readStdin() : readFile(input, "utf8");
}

function validationMessage(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as ReportValidationError).issues;
    return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * @command mate report [--days N] [--input FILE|-] [--json]
 * @description Generates a usage report from built-in collectors or a validated JSON document.
 */
export async function runReportCommand(
  argv: string[] = [],
  deps: ReportCommandDeps = {},
): Promise<void> {
  let options: ReportOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`Invalid report options: ${validationMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  let reportDocument: ReportDocument;
  if (options.input !== undefined) {
    try {
      reportDocument = parseReportDocument(await readStructuredInput(options.input, deps));
    } catch (error) {
      console.error(`Invalid report input: ${validationMessage(error)}`);
      process.exitCode = 1;
      return;
    }
  } else {
    const resolveCtx = deps.resolveFrameworkContext ?? resolveFrameworkContext;
    const { companionPath, configStore, workingRepoStore, repository, contextKind } =
      await resolveCtx(process.cwd());
    const config = await configStore.load();
    const working =
      repository || contextKind === "companion-root" ? null : await workingRepoStore.load();

    const workingRepoPath = repository?.path ?? working?.repos[0]?.path ?? process.cwd();
    const capabilities = config.capabilities ?? [];
    const enabledCapabilities = capabilities.map((c) => c.name);
    const activeAgents = process.env.MATE_ALLOWED_AGENTS
      ? process.env.MATE_ALLOWED_AGENTS.split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];

    const tokensaveEnabled = enabledCapabilities.includes("tokensave");
    const rtkEnabled = enabledCapabilities.includes("rtk");

    const ccusageResult = await collectCcusageSpending(options.days, deps);
    if (ccusageResult.friendlyError) console.warn(ccusageResult.friendlyError);

    let tokensaveWorking: Awaited<ReturnType<typeof collectTokenSaveSavings>> = {
      entry: null,
      status: { name: "tokensave (savings)", enabled: false, status: "not enabled" },
    };
    let tokensaveCompanion: Awaited<ReturnType<typeof collectTokenSaveSavings>> = {
      entry: null,
      status: { name: "tokensave (savings)", enabled: false, status: "not enabled" },
    };
    let rtkResult: Awaited<ReturnType<typeof collectRTKSavings>> = {
      entry: null,
      status: { name: "rtk", enabled: false, status: "not enabled" },
    };

    if (tokensaveEnabled) {
      [tokensaveWorking, tokensaveCompanion] = await Promise.all([
        collectTokenSaveSavings(workingRepoPath, options.days, deps),
        collectTokenSaveSavings(companionPath, options.days, deps),
      ]);
    }
    if (rtkEnabled) rtkResult = await collectRTKSavings(workingRepoPath, deps);

    const merged = mergeResults(
      ccusageResult.entries,
      tokensaveWorking.entry,
      tokensaveCompanion.entry,
      rtkResult.entry,
    );
    const reportData: ReportData = {
      days: options.days,
      generatedAt: new Date().toISOString(),
      workingRepoPath,
      companionRepoPath: companionPath,
      activeAgents,
      enabledCapabilities,
      spending: merged.spending,
      savings: merged.savings,
      toolStatus: [ccusageResult.status, tokensaveWorking.status, rtkResult.status],
      totalSpending: merged.totalSpending,
      totalSavings: merged.totalSavings,
      netSpend: merged.netSpend,
    };
    reportDocument = reportDataToDocument(reportData);
  }

  if (options.json) {
    console.log(renderJSON(reportDocument));
    return;
  }

  let reportPath: string | undefined;
  try {
    reportPath = await (deps.writeTemporaryReport ?? writeTemporaryReport)(
      renderHTML(reportDocument),
    );
    await (deps.openReportInBrowser ?? openReportInBrowser)(reportPath);
    console.log(`Report opened from ${reportPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const location = reportPath ? ` at ${reportPath}` : "";
    console.warn(`Unable to open HTML report${location}: ${message}`);
    console.log(renderJSON(reportDocument));
  }
}
