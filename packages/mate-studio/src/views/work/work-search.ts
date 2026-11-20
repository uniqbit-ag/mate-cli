import { WORK_BUCKETS, type WorkBucket } from "@uniqbit/mate-core/studio";

import type { StudioSearch } from "../../lib/search";

/** Work's address: the bucket shown. */
export interface WorkSearch extends StudioSearch {
  bucket?: WorkBucket;
}

/** Forgiving: an unknown bucket selects the default, Scratchpad. */
export function validateWorkSearch(raw: Record<string, unknown>): WorkSearch {
  return (WORK_BUCKETS as readonly unknown[]).includes(raw.bucket)
    ? { bucket: raw.bucket as WorkBucket }
    : {};
}
