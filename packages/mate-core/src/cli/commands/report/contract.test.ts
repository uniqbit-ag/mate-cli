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

  test("accepts a diagram with either payload and a diff", () => {
    const document: ReportDocument = {
      ...validDocument,
      sections: [
        {
          id: "structure",
          title: "Structure",
          type: "diagram",
          mermaid: "classDiagram\n  A --> B",
        },
        { id: "sketch", title: "Sketch", type: "diagram", text: "  A -> B" },
        { id: "changes", title: "Changes", type: "diff", patch: "diff --git a/a.ts b/a.ts" },
        { id: "nothing", title: "Nothing", type: "diff", patch: "" },
      ],
    };

    expect(validateReportDocument(document)).toEqual(document);
  });

  test("rejects diagrams that carry both payloads or neither", () => {
    const both = getReportDocumentIssues({
      ...validDocument,
      sections: [{ id: "both", title: "Both", type: "diagram", mermaid: "graph TD", text: "A" }],
    });
    const neither = getReportDocumentIssues({
      ...validDocument,
      sections: [{ id: "neither", title: "Neither", type: "diagram" }],
    });

    expect(both).toEqual([
      {
        path: "sections[0]",
        message: 'section "both" must carry exactly one of mermaid or text, but carries both',
      },
    ]);
    expect(neither).toEqual([
      {
        path: "sections[0]",
        message: 'section "neither" must carry exactly one of mermaid or text, but carries neither',
      },
    ]);
  });

  test("rejects non-string payloads and a missing patch", () => {
    const issues = getReportDocumentIssues({
      ...validDocument,
      sections: [
        { id: "typed", title: "Typed", type: "diagram", mermaid: 7 },
        { id: "blank", title: "Blank", type: "diagram", text: "   " },
        { id: "patchless", title: "Patchless", type: "diff" },
        { id: "typed-patch", title: "Typed patch", type: "diff", patch: ["a"] },
      ],
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "sections[0].mermaid",
        "sections[1].text",
        "sections[2].patch",
        "sections[3].patch",
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
