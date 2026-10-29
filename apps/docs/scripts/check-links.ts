/**
 * Post-build checks for the docs site. Run after `astro build`:
 * - every internal href/src in dist/ resolves to a built file
 * - authored content never hardcodes the site base
 * - every authored page is reachable from the sidebar page tree
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isMarkdown, walk } from "./lib.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const contentDir = join(root, "content", "docs");
const base = "/mate-cli";

function resolvesInDist(pathname: string): boolean {
  const local = decodeURIComponent(pathname.slice(base.length)).replace(/^\/+/, "");
  const target = join(dist, local);
  return (
    (existsSync(target) && statSync(target).isFile()) ||
    existsSync(join(target, "index.html")) ||
    existsSync(`${target}.html`)
  );
}

function checkBuiltLinks(): string[] {
  const errors: string[] = [];
  for (const file of walk(dist, (f) => f.endsWith(".html"))) {
    const html = readFileSync(file, "utf8");
    for (const [, url = ""] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (url === base || url.startsWith(`${base}/`)) {
        const pathname = url.split(/[?#]/)[0]!;
        if (!resolvesInDist(pathname)) {
          errors.push(`${relative(dist, file)}: broken link ${url}`);
        }
      } else if (url.startsWith("/")) {
        errors.push(`${relative(dist, file)}: link outside the site base: ${url}`);
      }
    }
  }
  return errors;
}

function checkHardcodedBase(): string[] {
  const errors: string[] = [];
  for (const file of walk(contentDir, isMarkdown)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/(?:\(|"|'|\]:\s*)\/mate-cli(?:\/|["')#\s]|$)/.test(line)) {
          errors.push(
            `${relative(root, file)}:${index + 1}: hardcoded site base, link to /docs/... instead`,
          );
        }
      });
  }
  return errors;
}

function readPages(dir: string): string[] | undefined {
  const meta = join(dir, "meta.json");
  if (!existsSync(meta)) return undefined;
  return (JSON.parse(readFileSync(meta, "utf8")) as { pages?: string[] }).pages;
}

/** Mirrors Fumadocs: a folder without an explicit `pages` list includes everything. */
function listed(dir: string, name: string): boolean {
  const pages = readPages(dir);
  return (
    !pages || pages.includes(name) || pages.some((entry) => entry === "..." || entry === "z...a")
  );
}

function checkPageTree(): string[] {
  const errors: string[] = [];
  for (const file of walk(contentDir, isMarkdown)) {
    const segments = relative(contentDir, file)
      .replace(/\.mdx?$/, "")
      .split(sep);
    let dir = contentDir;
    for (const segment of segments) {
      if (!listed(dir, segment)) {
        errors.push(
          `${relative(root, file)}: missing from the sidebar, add "${segment}" to ${relative(root, join(dir, "meta.json"))}`,
        );
        break;
      }
      dir = join(dir, segment);
    }
  }
  return errors;
}

if (!existsSync(dist)) {
  console.error("check-links: dist/ not found, run astro build first");
  process.exit(1);
}

const errors = [...checkBuiltLinks(), ...checkHardcodedBase(), ...checkPageTree()];
if (errors.length > 0) {
  console.error(
    `check-links: ${errors.length} problem(s)\n${errors.map((e) => `  ${e}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("check-links: all internal links resolve and every page is in the sidebar");
