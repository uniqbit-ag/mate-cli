import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  resolveFrameworkContext,
  type FrameworkContext,
} from "../../../lib/orchestrator/framework-context";
import { AmbiguousCompanionError, RepositoryNotFoundError } from "../../../lib/orchestrator/types";
import { collectCompanionUsage } from "../../../lib/usage/collect";
import { resolveUsageScope } from "../../../lib/usage/scope";
import { UsageError, type UsageErrorEnvelope } from "../../../lib/usage/types";
import { usageDays, usageWindow } from "../../../lib/usage/window";
import { parseReportDocument } from "./contract";
import { publishReportToStudio, writeTemporaryReport } from "./delivery";
import { renderHTML, renderJSON } from "./renderer";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";
import type { ReportDocument, ReportOptions } from "./types";

interface ReportCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveFrameworkContext?: (cwd: string) => Promise<Pick<FrameworkContext, "companionPath">>;
  resolveUsageScope?: typeof resolveUsageScope;
  collectCompanionUsage?: typeof collectCompanionUsage;
  writeTemporaryReport?: typeof writeTemporaryReport;
  publishReportToStudio?: typeof publishReportToStudio;
  readInput?: (input: string) => Promise<string>;
  writeOutput?: (output: string, html: string) => Promise<void>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

interface ReportDeliveryReceipt {
  kind: "report-delivery";
  version: 1;
  title: string;
  delivery:
    | { kind: "studio"; id: string; url?: string; surface?: "reports" }
    | { kind: "runner-output" }
    | { kind: "temporary-file"; path: string };
  warnings: string[];
}

function parseOptions(argv: string[]): ReportOptions {
  let days = 7;
  let json = false;
  let input: string | undefined;
  let daysSpecified = false;
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--days") {
      if (daysSpecified)
        throw new UsageError("INVALID_OPTIONS", "--days may only be supplied once");
      daysSpecified = true;
      days = usageDays(argv[++i]);
    } else if (option === "--input") {
      if (input !== undefined)
        throw new UsageError("INVALID_OPTIONS", "--input may only be supplied once");
      input = argv[++i];
      if (!input || (input !== "-" && input.startsWith("--")))
        throw new UsageError("INVALID_OPTIONS", "--input requires a JSON file or -");
    } else if (option === "--json") json = true;
    else throw new UsageError("INVALID_OPTIONS", "Unknown report option");
  }
  if (input !== undefined && daysSpecified)
    throw new UsageError("INVALID_OPTIONS", "--days cannot be combined with --input");
  return { days, json, input };
}

async function readStructuredInput(input: string): Promise<string> {
  if (input !== "-") return readFile(input, "utf8");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error("Input exceeds limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fail(
  error: UsageError,
  { fallback, issues }: { fallback?: ReportDocument; issues?: unknown } = {},
): void {
  const envelope: UsageErrorEnvelope = {
    kind: "error",
    version: 1,
    error: { code: error.code, message: error.message, ...(issues ? { issues } : {}) },
    ...(fallback ? { fallback } : {}),
  };
  console.error(error.message);
  console.log(JSON.stringify(envelope));
  process.exitCode = 1;
}

const companionAmbiguous = () =>
  new UsageError("COMPANION_AMBIGUOUS", "Select a Companion Repository before requesting usage");

function usageFailure(error: unknown): UsageError {
  if (error instanceof UsageError) return error;
  if (error instanceof AmbiguousCompanionError) return companionAmbiguous();
  if (error instanceof RepositoryNotFoundError)
    return new UsageError(
      "COMPANION_UNRESOLVED",
      "No Companion Repository resolves for this directory",
    );
  return new UsageError("COLLECTION_FAILED", "Unable to resolve or collect companion usage");
}

const isLocalHost = (host: string) =>
  ["localhost", "0.0.0.0", "[::]", "[::1]"].includes(host) ||
  host.endsWith(".localhost") ||
  /^127\.\d+\.\d+\.\d+$/.test(host);

/** Public, credential-free http(s) address; local or invalid URLs fall back to the Reports locator. */
function publicStudioUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !isLocalHost(url.hostname)
    )
      return url.href;
  } catch {
    /* Use the Reports locator for an invalid URL. */
  }
  return undefined;
}

function receipt(
  title: string,
  delivery: ReportDeliveryReceipt["delivery"],
  warnings: string[],
): ReportDeliveryReceipt {
  return { kind: "report-delivery", version: 1, title, delivery, warnings };
}

async function deliverReport(
  document: ReportDocument,
  deps: ReportCommandDeps,
): Promise<ReportDeliveryReceipt> {
  const html = renderHTML(document);
  const warnings: string[] = [];
  try {
    const hosted = await (deps.publishReportToStudio ?? publishReportToStudio)(
      document.title,
      html,
    );
    if (hosted) {
      const publicUrl = hosted.url ? publicStudioUrl(hosted.url) : undefined;
      return receipt(
        document.title,
        {
          kind: "studio",
          id: hosted.id,
          ...(publicUrl ? { url: publicUrl } : { surface: "reports" }),
        },
        warnings,
      );
    }
  } catch {
    warnings.push("Studio hosting was unavailable; report delivered locally");
  }
  const output = (deps.env ?? process.env).MATE_REPORT_OUTPUT;
  if (output) {
    const write =
      deps.writeOutput ??
      (async (file: string, content: string) => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
      });
    await write(output, html);
    return receipt(document.title, { kind: "runner-output" }, warnings);
  }
  const file = await (deps.writeTemporaryReport ?? writeTemporaryReport)(html);
  return receipt(document.title, { kind: "temporary-file", path: file }, warnings);
}

/**
 * @command mate report [--days N] [--input FILE|-] [--json]
 * @description Returns usage JSON or an explicit report's delivery receipt. Never opens a browser.
 */
export async function runReportCommand(
  argv: string[] = [],
  deps: ReportCommandDeps = {},
): Promise<void> {
  let options: ReportOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    fail(error as UsageError);
    return;
  }

  if (options.input !== undefined) {
    let document: ReportDocument;
    try {
      document = parseReportDocument(await (deps.readInput ?? readStructuredInput)(options.input));
    } catch (error) {
      const issues =
        error && typeof error === "object" && "issues" in error ? error.issues : undefined;
      fail(new UsageError("INVALID_REPORT_INPUT", "Invalid report input"), { issues });
      return;
    }
    if (options.json) {
      console.log(renderJSON(document));
      return;
    }
    try {
      console.log(JSON.stringify(await deliverReport(document, deps)));
    } catch {
      fail(new UsageError("REPORT_DELIVERY_FAILED", "Unable to deliver the report"), {
        fallback: document,
      });
    }
    return;
  }

  try {
    const now = deps.now?.() ?? new Date();
    const window = usageWindow(options.days, now);
    // Pins an env or projected choice; JSON callers get an error envelope, never a picker.
    const pinned = await (
      deps.ensureUnambiguousCompanion ??
      ((cwd: string) => ensureUnambiguousCompanion(cwd, { interactive: false }))
    )(process.cwd());
    if (!pinned) throw companionAmbiguous();
    const { companionPath } = await (deps.resolveFrameworkContext ?? resolveFrameworkContext)(
      process.cwd(),
    );
    const scope = await (deps.resolveUsageScope ?? resolveUsageScope)(companionPath);
    console.log(
      JSON.stringify(
        await (deps.collectCompanionUsage ?? collectCompanionUsage)(scope, window, {
          now: () => now,
        }),
      ),
    );
  } catch (error) {
    fail(usageFailure(error));
  }
}
