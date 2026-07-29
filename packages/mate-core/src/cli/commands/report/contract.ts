import {
  REPORT_DOCUMENT_VERSION,
  type ReportDocument,
  type ReportKeyValue,
  type ReportMetric,
  type ReportSection,
  type ReportStatus,
  type ReportValue,
} from "./types";

export interface ReportValidationIssue {
  path: string;
  message: string;
}

export class ReportValidationError extends Error {
  readonly issues: ReportValidationIssue[];

  constructor(issues: ReportValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ReportValidationError";
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReportValue = (value: unknown): value is ReportValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

function requiredString(
  value: unknown,
  path: string,
  issues: ReportValidationIssue[],
): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path, message: "must be a non-empty string" });
    return false;
  }
  return true;
}

function validateKeyValues(value: unknown, path: string, issues: ReportValidationIssue[]): boolean {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return false;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "must be an object" });
      return;
    }
    requiredString(item.label, `${itemPath}.label`, issues);
    if (!isReportValue(item.value)) {
      issues.push({
        path: `${itemPath}.value`,
        message: "must be a string, number, boolean, or null",
      });
    }
  });
  return true;
}

function validateMetrics(value: unknown, path: string, issues: ReportValidationIssue[]): boolean {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return false;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "must be an object" });
      return;
    }
    requiredString(item.label, `${itemPath}.label`, issues);
    if (!isReportValue(item.value)) {
      issues.push({
        path: `${itemPath}.value`,
        message: "must be a string, number, boolean, or null",
      });
    }
    if (item.detail !== undefined && typeof item.detail !== "string") {
      issues.push({ path: `${itemPath}.detail`, message: "must be a string" });
    }
  });
  return true;
}

function validateStatuses(value: unknown, path: string, issues: ReportValidationIssue[]): boolean {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return false;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "must be an object" });
      return;
    }
    requiredString(item.label, `${itemPath}.label`, issues);
    requiredString(item.status, `${itemPath}.status`, issues);
    if (item.detail !== undefined && typeof item.detail !== "string") {
      issues.push({ path: `${itemPath}.detail`, message: "must be a string" });
    }
  });
  return true;
}

function validateSection(value: unknown, path: string, issues: ReportValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }

  requiredString(value.id, `${path}.id`, issues);
  requiredString(value.title, `${path}.title`, issues);
  if (typeof value.type !== "string") {
    issues.push({ path: `${path}.type`, message: "must be a supported section type" });
    return;
  }

  switch (value.type) {
    case "metadata":
    case "key-value":
      validateKeyValues(value.items, `${path}.items`, issues);
      return;
    case "metrics":
      validateMetrics(value.items, `${path}.items`, issues);
      return;
    case "statuses":
      validateStatuses(value.items, `${path}.items`, issues);
      return;
    case "table": {
      if (!Array.isArray(value.columns) || value.columns.length === 0) {
        issues.push({ path: `${path}.columns`, message: "must be a non-empty string array" });
      } else {
        value.columns.forEach((column, index) => {
          if (typeof column !== "string" || column.trim() === "") {
            issues.push({
              path: `${path}.columns[${index}]`,
              message: "must be a non-empty string",
            });
          }
        });
      }
      if (!Array.isArray(value.rows)) {
        issues.push({ path: `${path}.rows`, message: "must be an array" });
      } else {
        value.rows.forEach((row, rowIndex) => {
          if (!Array.isArray(row)) {
            issues.push({ path: `${path}.rows[${rowIndex}]`, message: "must be an array" });
            return;
          }
          if (Array.isArray(value.columns) && row.length !== value.columns.length) {
            issues.push({
              path: `${path}.rows[${rowIndex}]`,
              message: `must contain ${value.columns.length} values`,
            });
          }
          row.forEach((cell, cellIndex) => {
            if (!isReportValue(cell)) {
              issues.push({
                path: `${path}.rows[${rowIndex}][${cellIndex}]`,
                message: "must be a string, number, boolean, or null",
              });
            }
          });
        });
      }
      return;
    }
    case "text":
      if (typeof value.content !== "string") {
        issues.push({ path: `${path}.content`, message: "must be a string" });
      }
      return;
    default:
      issues.push({
        path: `${path}.type`,
        message: "must be one of metadata, metrics, key-value, table, statuses, or text",
      });
  }
}

export function getReportDocumentIssues(input: unknown): ReportValidationIssue[] {
  const issues: ReportValidationIssue[] = [];
  if (!isRecord(input)) {
    return [{ path: "$", message: "must be an object" }];
  }

  if (input.version !== REPORT_DOCUMENT_VERSION) {
    issues.push({ path: "version", message: `must be ${REPORT_DOCUMENT_VERSION}` });
  }
  requiredString(input.title, "title", issues);
  requiredString(input.generatedAt, "generatedAt", issues);
  if (input.period !== undefined && typeof input.period !== "string") {
    issues.push({ path: "period", message: "must be a string" });
  }
  if (input.context !== undefined && typeof input.context !== "string") {
    issues.push({ path: "context", message: "must be a string" });
  }
  validateKeyValues(input.metadata, "metadata", issues);
  validateMetrics(input.summary, "summary", issues);
  if (!Array.isArray(input.sections)) {
    issues.push({ path: "sections", message: "must be an array" });
  } else {
    const ids = new Set<string>();
    input.sections.forEach((section, index) => {
      validateSection(section, `sections[${index}]`, issues);
      if (isRecord(section) && typeof section.id === "string") {
        if (ids.has(section.id)) {
          issues.push({ path: `sections[${index}].id`, message: "must be unique" });
        }
        ids.add(section.id);
      }
    });
  }
  return issues;
}

export function validateReportDocument(input: unknown): ReportDocument {
  const issues = getReportDocumentIssues(input);
  if (issues.length > 0) throw new ReportValidationError(issues);
  return input as ReportDocument;
}

export function parseReportDocument(json: string): ReportDocument {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (error) {
    throw new ReportValidationError([
      {
        path: "$",
        message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }
  return validateReportDocument(input);
}

export type {
  ReportDocument,
  ReportKeyValue,
  ReportMetric,
  ReportSection,
  ReportStatus,
  ReportValue,
};
