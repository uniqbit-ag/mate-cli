export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );

  const renderRow = (row: string[]): string =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;

  const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
  return [renderRow(headers), divider, ...rows.map(renderRow)].join("\n");
}

export function renderKeyValueTable(rows: Array<[string, string]>): string {
  return renderTable(["Field", "Value"], rows);
}

export function printSection(title: string, body: string): void {
  console.log(title);
  console.log(body);
  console.log("");
}
