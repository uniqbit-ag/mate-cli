import path from "node:path";

type CoverageLine = {
  hits: number;
  lineNumber: number;
};

type CoverageFile = {
  filePath: string;
  lines: CoverageLine[];
};

type CoberturaOptions = {
  projectRoot?: string;
  timestamp?: number;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeCoveragePath(filePath: string, projectRoot: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join("/");
  }

  const relativePath = path.relative(projectRoot, filePath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }

  return filePath.split(path.sep).join("/");
}

function finalizeRecord(
  records: CoverageFile[],
  activePath: string | null,
  activeLines: Map<number, number>,
  projectRoot: string,
) {
  if (!activePath) {
    return;
  }

  const lines = [...activeLines.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([lineNumber, hits]) => ({ hits, lineNumber }));

  records.push({
    filePath: normalizeCoveragePath(activePath, projectRoot),
    lines,
  });
}

export function parseLcov(lcov: string, projectRoot = process.cwd()): CoverageFile[] {
  const records: CoverageFile[] = [];
  let activePath: string | null = null;
  let activeLines = new Map<number, number>();

  for (const rawLine of lcov.split(/\r?\n/)) {
    if (rawLine.startsWith("SF:")) {
      finalizeRecord(records, activePath, activeLines, projectRoot);
      activePath = rawLine.slice(3).trim();
      activeLines = new Map<number, number>();
      continue;
    }

    if (rawLine.startsWith("DA:")) {
      const [lineNumberText, hitsText] = rawLine.slice(3).split(",");
      const lineNumber = Number.parseInt(lineNumberText ?? "", 10);
      const hits = Number.parseInt(hitsText ?? "", 10);

      if (Number.isFinite(lineNumber) && Number.isFinite(hits)) {
        activeLines.set(lineNumber, hits);
      }
      continue;
    }

    if (rawLine === "end_of_record") {
      finalizeRecord(records, activePath, activeLines, projectRoot);
      activePath = null;
      activeLines = new Map<number, number>();
    }
  }

  finalizeRecord(records, activePath, activeLines, projectRoot);
  return records;
}

export function lcovToCobertura(
  lcov: string,
  { projectRoot = process.cwd(), timestamp = Date.now() }: CoberturaOptions = {},
): string {
  const files = parseLcov(lcov, projectRoot);
  const packages = new Map<string, CoverageFile[]>();

  for (const file of files) {
    const packageName = path.posix.dirname(file.filePath);
    const bucket = packages.get(packageName) ?? [];
    bucket.push(file);
    packages.set(packageName, bucket);
  }

  const totalLinesValid = files.reduce((sum, file) => sum + file.lines.length, 0);
  const totalLinesCovered = files.reduce(
    (sum, file) => sum + file.lines.filter((line) => line.hits > 0).length,
    0,
  );
  const totalLineRate = totalLinesValid === 0 ? 0 : totalLinesCovered / totalLinesValid;

  const packageXml = [...packages.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([packageName, packageFiles]) => {
      const packageLinesValid = packageFiles.reduce((sum, file) => sum + file.lines.length, 0);
      const packageLinesCovered = packageFiles.reduce(
        (sum, file) => sum + file.lines.filter((line) => line.hits > 0).length,
        0,
      );
      const packageLineRate = packageLinesValid === 0 ? 0 : packageLinesCovered / packageLinesValid;

      const classesXml = packageFiles
        .toSorted((left, right) => left.filePath.localeCompare(right.filePath))
        .map((file) => {
          const fileLinesCovered = file.lines.filter((line) => line.hits > 0).length;
          const fileLineRate = file.lines.length === 0 ? 0 : fileLinesCovered / file.lines.length;
          const linesXml = file.lines
            .map(
              (line) =>
                `          <line number="${line.lineNumber}" hits="${line.hits}" branch="false"/>`,
            )
            .join("\n");

          return [
            `      <class name="${escapeXml(path.posix.basename(file.filePath))}" filename="${escapeXml(file.filePath)}" line-rate="${fileLineRate.toFixed(4)}" branch-rate="0" complexity="0">`,
            "        <methods/>",
            "        <lines>",
            linesXml,
            "        </lines>",
            "      </class>",
          ].join("\n");
        })
        .join("\n");

      return [
        `    <package name="${escapeXml(packageName)}" line-rate="${packageLineRate.toFixed(4)}" branch-rate="0" complexity="0">`,
        "      <classes>",
        classesXml,
        "      </classes>",
        "    </package>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
    `<coverage lines-covered="${totalLinesCovered}" lines-valid="${totalLinesValid}" line-rate="${totalLineRate.toFixed(4)}" branches-covered="0" branches-valid="0" branch-rate="0" complexity="0" version="mate-lcov-to-cobertura" timestamp="${Math.floor(
      timestamp / 1000,
    )}">`,
    "  <sources>",
    "    <source>.</source>",
    "  </sources>",
    "  <packages>",
    packageXml,
    "  </packages>",
    "</coverage>",
    "",
  ].join("\n");
}
