import { describe, expect, test } from "bun:test";

import {
  getReportDocumentIssues,
  parseReportDocument,
  ReportValidationError,
  validateReportDocument,
} from "./contract";
import { REPORT_DOCUMENT_VERSION, type ReportDocument } from "./types";

const validDocument: ReportDocument = {
  version: REPORT_DOCUMENT_VERSION,
  title: "Example report",
  generatedAt: "2026-01-01T00:00:00Z",
  metadata: [{ label: "Owner", value: "acme" }],
  summary: [{ label: "Requests", value: 42 }],
  sections: [
    { id: "notes", title: "Notes", type: "text", content: "Example" },
    {
      id: "results",
      title: "Results",
      type: "table",
      columns: ["Name", "Value"],
      rows: [["one", 1]],
    },
  ],
};

describe("ReportDocument contract", () => {
  test("accepts a valid mixed document", () => {
    expect(validateReportDocument(validDocument)).toEqual(validDocument);
    expect(parseReportDocument(JSON.stringify(validDocument))).toEqual(validDocument);
  });

  test("reports field-specific diagnostics", () => {
    const issues = getReportDocumentIssues({
      version: 2,
      title: "",
      generatedAt: "now",
      metadata: [],
      summary: [],
      sections: [
        { id: "same", title: "One", type: "table", columns: ["A"], rows: [[1, 2]] },
        { id: "same", title: "Two", type: "unknown" },
      ],
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "version",
        "title",
        "sections[0].rows[0]",
        "sections[1].type",
        "sections[1].id",
      ]),
    );
  });

  test("rejects invalid JSON and unsupported section shapes", () => {
    expect(() => parseReportDocument("not json")).toThrow(ReportValidationError);
    expect(() =>
      validateReportDocument({
        ...validDocument,
        sections: [{ ...validDocument.sections[0], type: "html" }],
      }),
    ).toThrow(/one of metadata/);
  });
});
