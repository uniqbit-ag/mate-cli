import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";
import { structure, type StructuredData } from "fumadocs-core/mdx-plugins";
import { loader, type StaticSource } from "fumadocs-core/source";
import * as path from "node:path";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export const source = loader({
  baseUrl: `${base}/docs`,
  source: await createSource(),
});

export function withBase(path: string): string {
  return `${base}${path}`;
}

export function getStructuredData(entry: CollectionEntry<"docs">): StructuredData {
  return structure(entry.body ?? "");
}

async function createSource() {
  const out: StaticSource<{
    metaData: CollectionEntry<"meta">["data"];
    pageData: CollectionEntry<"docs">["data"] & {
      _raw: CollectionEntry<"docs">;
    };
  }> = {
    files: [],
  };

  for (const page of await getCollection("docs")) {
    out.files.push({
      type: "page",
      path: path.relative("content/docs", page.filePath!),
      data: {
        ...page.data,
        _raw: page,
      },
    });
  }

  for (const meta of await getCollection("meta")) {
    out.files.push({
      type: "meta",
      path: path.relative("content/docs", meta.filePath!),
      data: meta.data,
    });
  }

  return out;
}
